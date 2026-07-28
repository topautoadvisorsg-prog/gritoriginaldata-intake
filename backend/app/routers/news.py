"""
News / Signal Intelligence Router — Event-Driven

Endpoints:
  GET  /news/event-status       — current tracked event + fighter scan state
  POST /news/fetch              — operator-triggered scan (event-driven, per-fighter)
  GET  /news/signals            — filtered signal list (default: importance >= 3)
  PATCH /news/{id}/approve      — approve signal
  PATCH /news/{id}/reject       — reject signal
  DELETE /news/{id}             — delete signal

DB column mapping (news_articles table):
  importance (1-5 int)  → subtitle   (stored as "1".."5")
  source_reliability    → excerpt    (high/medium/low)
  source_name           → author     (TEXT)
  signal_type           → signal_type
  headline              → title + headline
  summary               → summary
  source_url            → source_url
  admin_status          → admin_status (pending/approved/rejected)
  fighter_id            → fighter_id
  topic_tags            → topic_tags  (fighter names + event)
"""
import os
import json
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, BackgroundTasks
from anthropic import Anthropic

from app.database.supabase_client import get_supabase
from app.utils.fighter_tracking import (
    needs_full_scan,
    freshness_for_fighter,
    mark_scanned,
    get_all_tracked,
)
from app.utils.news_fetcher import search_for_fighter
from app.prompts_news import SIGNAL_CLASSIFICATION_PROMPT

router = APIRouter(prefix="/news", tags=["News Signals"])


# ── Anthropic client ──────────────────────────────────────────────────────────

def _get_anthropic() -> Anthropic:
    key = os.getenv("ANTHROPIC_API_KEY")
    if not key:
        raise ValueError("ANTHROPIC_API_KEY not set")
    return Anthropic(api_key=key)


def _db():
    return get_supabase()


# ── Event resolution ──────────────────────────────────────────────────────────

def _get_next_event() -> Optional[dict]:
    """Return the next upcoming event from the DB, or None."""
    supabase = _db()
    today = datetime.now(timezone.utc).date().isoformat()
    try:
        res = supabase.table("events") \
            .select("id,name,date") \
            .gte("date", today) \
            .order("date") \
            .limit(1) \
            .execute()
        return res.data[0] if res.data else None
    except Exception as e:
        print(f"[NewsSignals] Could not fetch next event: {e}")
        return None


def _get_fighters_for_event(event_id: str) -> list[dict]:
    """
    Return fighters scheduled for a given event.
    Tries event_fights first; falls back to fight_history.
    Returns list of {fighter_id, fighter_name}.
    """
    supabase = _db()
    fighters = []

    # Try event_fights
    try:
        res = supabase.table("event_fights") \
            .select("fighter1_id, fighter2_id") \
            .eq("event_id", event_id) \
            .execute()
        if res.data:
            ids = set()
            for row in res.data:
                if row.get("fighter1_id"):
                    ids.add(row["fighter1_id"])
                if row.get("fighter2_id"):
                    ids.add(row["fighter2_id"])
            if ids:
                f_res = supabase.table("fighters") \
                    .select("id, first_name, last_name") \
                    .in_("id", list(ids)) \
                    .execute()
                for f in (f_res.data or []):
                    fighters.append({
                        "fighter_id":   f["id"],
                        "fighter_name": f"{f.get('first_name','')} {f.get('last_name','')}".strip(),
                    })
                if fighters:
                    return fighters
    except Exception as e:
        print(f"[NewsSignals] event_fights lookup failed: {e}")

    # Fallback: fight_history linked to event by name
    # (requires the event to be in DB and fight_history.event_name to match)
    try:
        ev_res = supabase.table("events").select("name").eq("id", event_id).limit(1).execute()
        if ev_res.data:
            event_name = ev_res.data[0]["name"]
            fh_res = supabase.table("fight_history") \
                .select("fighter_id") \
                .ilike("event_name", f"%{event_name}%") \
                .execute()
            ids = {r["fighter_id"] for r in (fh_res.data or []) if r.get("fighter_id")}
            if ids:
                f_res = supabase.table("fighters") \
                    .select("id, first_name, last_name") \
                    .in_("id", list(ids)) \
                    .execute()
                for f in (f_res.data or []):
                    fighters.append({
                        "fighter_id":   f["id"],
                        "fighter_name": f"{f.get('first_name','')} {f.get('last_name','')}".strip(),
                    })
    except Exception as e:
        print(f"[NewsSignals] fight_history fallback failed: {e}")

    return fighters


# ── Claude classification ─────────────────────────────────────────────────────

def _classify_article(article: dict) -> Optional[dict]:
    """
    Classify a single article for one fighter.
    Returns structured signal dict or None on failure.
    """
    system_prompt = SIGNAL_CLASSIFICATION_PROMPT.split("ARTICLE TO ANALYSE:")[0].strip()
    fighter_name = article.get("fighter_name", "the fighter")
    user_content = (
        f"Fighter being tracked: {fighter_name}\n"
        "ARTICLE TO ANALYSE:\n"
        f"Source: {article.get('source_name', 'Unknown')}\n"
        f"Title: {article.get('title', '')}\n"
        f"Content:\n{article.get('content', '')[:3000]}"
    )

    try:
        client = _get_anthropic()
        msg = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=500,
            system=system_prompt,
            messages=[{"role": "user", "content": user_content}],
        )
        raw = msg.content[0].text.strip()
        if "```json" in raw:
            raw = raw.split("```json")[1].split("```")[0].strip()
        elif "```" in raw:
            raw = raw.split("```")[1].split("```")[0].strip()
        start = raw.find("{")
        end = raw.rfind("}")
        if start != -1 and end > start:
            raw = raw[start:end + 1]
        result = json.loads(raw)
        if not isinstance(result, dict):
            return None
        # Normalise importance to int
        try:
            result["importance"] = int(result.get("importance", 1))
        except (TypeError, ValueError):
            result["importance"] = 1
        return result
    except Exception as e:
        print(f"[NewsSignals] Classify error: {e}")
        return None


# ── DB write ──────────────────────────────────────────────────────────────────

def _insert_signal(article: dict, classified: dict, fighter_id: Optional[str], event_name: str):
    """Insert a classified signal into news_articles."""
    supabase = _db()
    importance = classified.get("importance", 1)
    signal_type = classified.get("signal_type", "general_news")
    fighter_name = classified.get("fighter_name") or article.get("fighter_name", "")

    tags = [fighter_name] if fighter_name else []
    if event_name:
        tags.append(event_name)
    tags += classified.get("tags", [])

    headline = classified.get("headline") or article.get("title", "")
    summary  = classified.get("summary", "")

    payload = {
        "title":        headline,
        "headline":     headline,
        "content":      summary or headline,         # NOT NULL — use summary as body
        "summary":      summary,
        "subtitle":     str(importance),             # importance 1-5 as string
        "excerpt":      classified.get("source_reliability", "medium"),
        "author":       article.get("source_name", ""),
        "signal_type":  signal_type,
        "source_url":   article.get("url", ""),
        "published_at": article.get("published_at") or datetime.now(timezone.utc).isoformat(),
        "admin_status": "pending",
        "layer":        "intelligence" if importance >= 3 else "standard",
        "topic_tags":   list(dict.fromkeys(tags)),  # dedupe, preserve order
        "is_published": False,
    }
    if fighter_id:
        payload["fighter_id"] = fighter_id

    try:
        supabase.table("news_articles").insert(payload).execute()
        print(f"[NewsSignals] Stored signal importance={importance} | {payload['title'][:60]}")
    except Exception as e:
        print(f"[NewsSignals] Insert error: {e}")


# ── Background task ───────────────────────────────────────────────────────────

def _run_event_scan():
    """
    Event-driven scan:
    1. Find next upcoming event
    2. Get all fighters on that card
    3. For each fighter: full scan (first time) or incremental (repeat)
    4. Classify each article; store importance >= 2
    5. Update tracking timestamps
    """
    supabase = _db()

    event = _get_next_event()
    if not event:
        print("[NewsSignals] No upcoming events found — create an event first")
        return

    event_id   = event["id"]
    event_name = event["name"]
    print(f"[NewsSignals] Scanning for event: {event_name} ({event['date']})")

    fighters = _get_fighters_for_event(event_id)
    if not fighters:
        print(f"[NewsSignals] No fighters linked to {event_name} — ingest the card first")
        return

    print(f"[NewsSignals] Tracking {len(fighters)} fighters")

    # Get already-stored URLs to avoid duplicates
    try:
        res = supabase.table("news_articles").select("source_url").execute()
        known_urls = {r["source_url"] for r in (res.data or []) if r.get("source_url")}
    except Exception:
        known_urls = set()

    total_stored = 0
    total_skipped = 0

    for fighter in fighters:
        fid   = fighter["fighter_id"]
        fname = fighter["fighter_name"]
        is_full = needs_full_scan(fid)
        freshness = "pm" if is_full else freshness_for_fighter(fid)

        scan_label = "FULL" if is_full else f"INCREMENTAL (freshness={freshness})"
        print(f"[NewsSignals] {fname} — {scan_label}")

        articles = search_for_fighter(fname, freshness=freshness, known_urls=known_urls)
        if not articles:
            mark_scanned(fid, fname, event_id, event_name, "full" if is_full else "incremental")
            continue

        fighter_stored = 0
        for article in articles:
            classified = _classify_article(article)
            if not classified:
                total_skipped += 1
                continue
            importance = classified.get("importance", 1)
            # Store importance >= 2; surface >= 3 in UI
            if importance < 2:
                total_skipped += 1
                print(f"[NewsSignals] Dropped importance=1 noise: {article.get('title','')[:50]}")
                continue
            url = article.get("url", "")
            if url:
                known_urls.add(url)
            _insert_signal(article, classified, fid, event_name)
            fighter_stored += 1
            total_stored += 1

        print(f"[NewsSignals] {fname} → stored={fighter_stored}")
        mark_scanned(fid, fname, event_id, event_name, "full" if is_full else "incremental")

    print(f"[NewsSignals] Scan complete — stored={total_stored}, skipped={total_skipped}")


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/event-status")
async def event_status():
    """
    Returns the current tracked event and per-fighter scan state.
    Used by the frontend to show what's being tracked.
    """
    event = _get_next_event()
    if not event:
        return {
            "event": None,
            "fighters": [],
            "message": "No upcoming events found. Create your next event first.",
        }

    fighters_on_card = _get_fighters_for_event(event["id"])
    tracking_records = {r["fighter_id"]: r for r in get_all_tracked()}

    fighters_state = []
    for f in fighters_on_card:
        fid = f["fighter_id"]
        record = tracking_records.get(fid, {})
        fighters_state.append({
            "fighter_id":                fid,
            "fighter_name":              f["fighter_name"],
            "last_full_scan_at":         record.get("last_full_scan_at"),
            "last_incremental_scan_at":  record.get("last_incremental_scan_at"),
            "scan_type":                 "full" if not record.get("last_full_scan_at") else "incremental",
        })

    return {
        "event": {
            "id":   event["id"],
            "name": event["name"],
            "date": event["date"],
        },
        "fighters": fighters_state,
        "message": None,
    }


@router.post("/fetch")
async def trigger_fetch(background_tasks: BackgroundTasks):
    """
    Operator-triggered event-driven scan.
    Scans only fighters in the next upcoming event.
    """
    event = _get_next_event()
    if not event:
        return {
            "status": "no_event",
            "message": "No upcoming events found. Create your next event first, then ingest the card.",
        }

    fighters = _get_fighters_for_event(event["id"])
    if not fighters:
        return {
            "status": "no_fighters",
            "message": f"Event '{event['name']}' found but no fighters are linked. Ingest the card first.",
        }

    background_tasks.add_task(_run_event_scan)
    return {
        "status": "scanning",
        "event":  event["name"],
        "fighter_count": len(fighters),
        "message": f"Scanning {len(fighters)} fighters for {event['name']}. Signals will appear shortly.",
    }


@router.get("/signals")
async def list_signals(
    min_importance: int = 3,
    signal_type: Optional[str] = None,
    status: Optional[str] = None,
    fighter_id: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
):
    """
    List signals. Default: importance >= 3 only.
    Set min_importance=1 to see everything.
    """
    supabase = _db()
    query = supabase.table("news_articles").select(
        "id, title, headline, summary, subtitle, excerpt, author, "
        "signal_type, source_url, published_at, admin_status, "
        "topic_tags, layer, fighter_id, created_at"
    ).order("created_at", desc=True)

    # Filter importance — subtitle stores "1".."5"
    if min_importance > 1:
        query = query.gte("subtitle", str(min_importance))

    if signal_type:
        query = query.eq("signal_type", signal_type)
    if status:
        query = query.eq("admin_status", status)
    if fighter_id:
        query = query.eq("fighter_id", fighter_id)

    res = query.range(offset, offset + limit - 1).execute()

    signals = []
    for row in (res.data or []):
        try:
            importance = int(row.get("subtitle", "1"))
        except (ValueError, TypeError):
            importance = 1
        signals.append({
            "id":               row["id"],
            "headline":         row.get("headline") or row.get("title", ""),
            "summary":          row.get("summary", ""),
            "importance":       importance,
            "source_reliability": row.get("excerpt", "medium"),
            "source_name":      row.get("author", ""),
            "signal_type":      row.get("signal_type", "general_news"),
            "source_url":       row.get("source_url", ""),
            "published_at":     row.get("published_at"),
            "admin_status":     row.get("admin_status", "pending"),
            "fighter_names":    row.get("topic_tags", []),
            "fighter_id":       row.get("fighter_id"),
            "created_at":       row.get("created_at"),
        })

    return signals


@router.patch("/{signal_id}/approve")
async def approve_signal(signal_id: str):
    supabase = _db()
    res = supabase.table("news_articles") \
        .update({"admin_status": "approved"}) \
        .eq("id", signal_id) \
        .execute()
    return {"id": signal_id, "admin_status": "approved"}


@router.patch("/{signal_id}/reject")
async def reject_signal(signal_id: str):
    supabase = _db()
    supabase.table("news_articles") \
        .update({"admin_status": "rejected"}) \
        .eq("id", signal_id) \
        .execute()
    return {"id": signal_id, "admin_status": "rejected"}


@router.delete("/{signal_id}")
async def delete_signal(signal_id: str):
    supabase = _db()
    supabase.table("news_articles").delete().eq("id", signal_id).execute()
    return {"id": signal_id, "deleted": True}
