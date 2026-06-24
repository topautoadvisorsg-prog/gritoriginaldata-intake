from fastapi import FastAPI, HTTPException, BackgroundTasks, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional, Dict
import os
import json
import logging
import uvicorn
from PIL import Image
import io

logger = logging.getLogger(__name__)

# ── API key persistence ────────────────────────────────────────────────────────
_KEYS_FILE = os.path.join(os.path.dirname(__file__), "..", ".api_keys.json")

def _load_saved_keys():
    """Load persisted API keys from disk into os.environ on startup."""
    try:
        path = os.path.abspath(_KEYS_FILE)
        if os.path.exists(path):
            with open(path) as f:
                saved: dict = json.load(f)
            for k, v in saved.items():
                if k and v and k not in os.environ:
                    os.environ[k] = v
    except Exception as e:
        print(f"WARNING: could not load saved API keys: {e}")

def _save_keys(keys: dict):
    """Persist API keys to disk (merged with existing)."""
    path = os.path.abspath(_KEYS_FILE)
    existing: dict = {}
    try:
        if os.path.exists(path):
            with open(path) as f:
                existing = json.load(f)
    except Exception:
        pass
    existing.update({k: v for k, v in keys.items() if v})
    with open(path, "w") as f:
        json.dump(existing, f, indent=2)

_load_saved_keys()

# Bridge SUPABASE_API_KEY → SUPABASE_SERVICE_KEY so the Supabase client finds it.
if os.environ.get("SUPABASE_API_KEY") and not os.environ.get("SUPABASE_SERVICE_KEY"):
    os.environ["SUPABASE_SERVICE_KEY"] = os.environ["SUPABASE_API_KEY"]

app = FastAPI(title="MMA Data Ingestion Pipeline")

# CORS — narrow allow-list because `allow_origins=["*"]` + `allow_credentials=True`
# is a broken combo per the CORS spec (browsers drop the request).
# Operator dashboard runs on localhost:5000 in dev; allow override via env for prod.
_cors_origins_env = os.environ.get("CORS_ORIGINS", "http://localhost:5000,http://localhost:5173,http://127.0.0.1:5000,http://127.0.0.1:5173")
_cors_origins = [o.strip() for o in _cors_origins_env.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Manual ingestion router ────────────────────────────────────────────────────
from app.routers.ingest import router as ingest_router
app.include_router(ingest_router)

# ── News / Signal intelligence router ─────────────────────────────────────────
from app.routers.news import router as news_router
app.include_router(news_router)

_pipeline = None

def get_pipeline():
    global _pipeline
    if _pipeline is None:
        from app.agents.pipeline_manager import PipelineManager
        _pipeline = PipelineManager()
    return _pipeline

def db():
    from app.database.supabase_client import get_supabase
    return get_supabase()

@app.on_event("startup")
async def startup_event():
    try:
        from app.scheduler.tasks import start_scheduler
        start_scheduler()
    except Exception as e:
        print(f"WARNING: Scheduler could not start: {e}")

class EventScanRequest(BaseModel):
    event_name: str

# ── Root ──────────────────────────────────────────────────────────────────────

@app.get("/")
async def root():
    return {"message": "MMA Data Ingestion Pipeline API is running"}

# ── Stats ─────────────────────────────────────────────────────────────────────

@app.get("/fighters/recent")
async def get_recent_fighters():
    """Returns the last 10 fighters for the dashboard activity feed."""
    # We order by id descending as a heuristic if created_at is missing, 
    # but preferably we just want the last several in the table.
    response = db().table("fighters")\
        .select("id,first_name,last_name,is_verified,admin_status,image_url")\
        .limit(10)\
        .execute()
    # Sort by ID or just return the data if the table is small
    return response.data

@app.get("/pipeline/stats")
async def get_pipeline_stats():
    supabase = db()
    from datetime import date
    today = date.today().isoformat()

    def safe_count(fn):
        try:
            res = fn()
            return res.count or 0
        except Exception:
            return 0

    total     = safe_count(lambda: supabase.table("fighters").select("count", count="exact").execute())
    verified  = safe_count(lambda: supabase.table("fighters").select("count", count="exact").eq("is_verified", True).execute())
    news_today= safe_count(lambda: supabase.table("news_articles").select("count", count="exact").gte("created_at", f"{today}T00:00:00").execute())
    odds_staging = safe_count(lambda: supabase.table("odds").select("count", count="exact").eq("status", "staging").execute())
    images_pending = safe_count(lambda: supabase.table("fighters").select("count", count="exact").or_("image_url.is.null,body_image_url.is.null").execute())

    return {
        "total_fighters": total,
        "verified_fighters": verified,
        "unverified_fighters": total - verified,
        "news_today": news_today,
        "odds_staging": odds_staging,
        "images_pending": images_pending,
    }

# ── Test Connection ───────────────────────────────────────────────────────────

@app.get("/pipeline/test-connection")
async def test_connection():
    """
    Validates all external connections required by the pipeline:
      - Supabase DB (read fighters table)
      - Sherdog scraper (live HTTP fetch for a known fighter)
      - UFCStats scraper (live HTTP fetch for a known event)
      - GRIT webhook reachability (HEAD request, no data sent)
      - Environment variable presence (API keys, not values)
    """
    import requests
    from app.scrapers.sherdog_scraper import SherdogScraper
    from app.scrapers.ufcstats_scraper import UFCStatsScraper

    results: dict = {}

    # 1. Supabase
    try:
        supabase = db()
        res = supabase.table("fighters").select("count", count="exact").execute()
        results["supabase"] = {"status": "ok", "fighters_count": res.count or 0}
    except Exception as e:
        results["supabase"] = {"status": "error", "detail": str(e)}

    # 2. Sherdog scraper — Jon Jones profile (small known page)
    try:
        scraper = SherdogScraper()
        profile = scraper.get_fighter_profile("https://www.sherdog.com/fighter/Jon-Jones-27944")
        if profile.get("name"):
            results["sherdog_scraper"] = {"status": "ok", "sample_name": profile["name"]}
        else:
            results["sherdog_scraper"] = {"status": "error", "detail": "Fetched page but could not extract fighter name"}
    except Exception as e:
        results["sherdog_scraper"] = {"status": "error", "detail": str(e)}

    # 3. UFCStats scraper — confirmed accessible event page
    try:
        scraper = UFCStatsScraper()
        card = scraper.get_fight_card("http://ufcstats.com/event-details/5c38639f860a5542")
        if card.get("fighters"):
            results["ufcstats_scraper"] = {
                "status": "ok",
                "event": card["metadata"].get("event_name"),
                "fighters_found": len(card["fighters"]),
            }
        else:
            results["ufcstats_scraper"] = {"status": "error", "detail": "Fetched page but found no fighters"}
    except Exception as e:
        results["ufcstats_scraper"] = {"status": "error", "detail": str(e)}

    # 4. GRIT webhook reachability — GET the base app URL to confirm DNS/TLS resolves
    try:
        import ssl
        main_app_url = os.environ.get("MAIN_APP_API_URL", "").rstrip("/")
        webhook_url = f"{main_app_url}/api/webhooks/data-engine/webhook"
        # Use the system CA store for TLS verification (works on Railway + locally)
        system_ca = ssl.get_default_verify_paths().cafile or True
        resp = requests.get(main_app_url, timeout=10, verify=system_ca)
        results["grit_webhook"] = {
            "status": "ok" if resp.status_code < 500 else "error",
            "http_status": resp.status_code,
            "webhook_url": webhook_url,
            "note": "reachability check via GET to base URL; webhook only accepts POST",
        }
    except Exception as e:
        results["grit_webhook"] = {"status": "error", "detail": str(e)}

    # 5. Environment variable presence
    env_checks = {
        "SUPABASE_URL": bool(os.environ.get("SUPABASE_URL")),
        "SUPABASE_SERVICE_KEY": bool(os.environ.get("SUPABASE_SERVICE_KEY") or os.environ.get("SUPABASE_API_KEY")),
        "MAIN_APP_API_URL": bool(os.environ.get("MAIN_APP_API_URL")),
        "DATA_ENGINE_API_KEY": bool(os.environ.get("DATA_ENGINE_API_KEY")),
        "ANTHROPIC_API_KEY": bool(os.environ.get("ANTHROPIC_API_KEY")),
        "BRAVE_API_KEY": bool(os.environ.get("BRAVE_API_KEY")),
        "OPENAI_API_KEY": bool(os.environ.get("OPENAI_API_KEY")),
    }
    missing = [k for k, v in env_checks.items() if not v]
    results["env_vars"] = {
        "status": "ok" if not missing else "warning",
        "present": [k for k, v in env_checks.items() if v],
        "missing": missing,
    }

    overall = "ok" if all(r.get("status") == "ok" for r in results.values()) else "degraded"
    return {"overall": overall, "checks": results}


# ── API Key Configuration ──────────────────────────────────────────────────────

class ApiKeysPayload(BaseModel):
    keys: Dict[str, str]

_ALLOWED_KEYS = {
    "BRAVE_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "DATA_ENGINE_API_KEY",
    "MAIN_APP_API_URL",
    "SUPABASE_API_KEY",
}

@app.get("/config/keys/status")
async def get_keys_status():
    """Returns which configurable API keys are currently set (never returns values)."""
    def _is_set(k: str) -> bool:
        if os.environ.get(k):
            return True
        # Check bridged env vars so pre-configured secrets still show as "Set"
        if k == "SUPABASE_API_KEY" and os.environ.get("SUPABASE_SERVICE_KEY"):
            return True
        return False

    return {k: _is_set(k) for k in _ALLOWED_KEYS}

@app.post("/config/keys")
async def set_api_keys(payload: ApiKeysPayload):
    """
    Set one or more API keys at runtime.
    Values are stored in os.environ immediately and persisted to .api_keys.json
    so they survive server restarts.
    """
    rejected = [k for k in payload.keys if k not in _ALLOWED_KEYS]
    if rejected:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown or disallowed key names: {rejected}. "
                   f"Allowed: {sorted(_ALLOWED_KEYS)}",
        )

    updated = []
    for k, v in payload.keys.items():
        if v:
            os.environ[k] = v
            updated.append(k)
            # Bridge SUPABASE_API_KEY → SUPABASE_SERVICE_KEY at runtime too
            if k == "SUPABASE_API_KEY":
                os.environ["SUPABASE_SERVICE_KEY"] = v

    if updated:
        _save_keys({k: payload.keys[k] for k in updated})

    return {
        "saved": updated,
        "status": {k: bool(os.environ.get(k)) for k in _ALLOWED_KEYS},
    }


# ── Fighters ──────────────────────────────────────────────────────────────────

@app.get("/fighters")
async def get_fighters(
    limit: int = 200,
    offset: int = 0,
    verified: Optional[str] = None,   # "true" | "false" | None (all)
):
    query = db().table("fighters").select(
        "id,first_name,last_name,nickname,weight_class,wins,losses,draws,nc,"
        "image_url,admin_status,is_verified,stance,nationality,gym"
    )
    if verified == "true":
        query = query.eq("is_verified", True)
    elif verified == "false":
        query = query.eq("is_verified", False)
    response = query.order("last_name").range(offset, offset + limit).execute()
    return response.data


class VerifyRequest(BaseModel):
    is_verified: bool


@app.patch("/fighters/{fighter_id}/verify")
async def verify_fighter(fighter_id: str, req: VerifyRequest):
    payload: dict = {"is_verified": req.is_verified}
    # verified_at column added via migration 012 — set if column exists
    try:
        from datetime import datetime, timezone
        ts = datetime.now(timezone.utc).isoformat() if req.is_verified else None
        res = db().table("fighters").update({**payload, "verified_at": ts}).eq("id", fighter_id).execute()
    except Exception:
        # Column not yet applied — fall back to is_verified only
        res = db().table("fighters").update(payload).eq("id", fighter_id).execute()
    if not res.data:
        raise HTTPException(status_code=404, detail="Fighter not found")
    action = "verified" if req.is_verified else "unverified"
    print(f"[API] Fighter {fighter_id} {action}")
    return {"id": fighter_id, "is_verified": req.is_verified, "action": action}


class BulkDeleteRequest(BaseModel):
    confirm: str


@app.delete("/fighters/unverified")
async def bulk_delete_unverified(req: BulkDeleteRequest):
    if req.confirm != "DELETE_UNVERIFIED":
        raise HTTPException(
            status_code=400,
            detail='confirm must be exactly "DELETE_UNVERIFIED" to proceed'
        )
    supabase = db()

    # Get IDs of all unverified fighters first
    ids_res = supabase.table("fighters").select("id").eq("is_verified", False).execute()
    ids = [r["id"] for r in (ids_res.data or [])]
    if not ids:
        return {"deleted": 0, "message": "No unverified fighters found"}

    # Cascade: delete fight_history rows first (FK constraint)
    try:
        supabase.table("fight_history").delete().in_("fighter_id", ids).execute()
    except Exception as e:
        print(f"[BulkDelete] fight_history cascade warning: {e}")

    # Delete the fighters
    del_res = supabase.table("fighters").delete().eq("is_verified", False).execute()
    count = len(del_res.data or [])
    print(f"[API] Bulk deleted {count} unverified fighters (IDs: {ids[:5]}{'...' if len(ids) > 5 else ''})")
    return {"deleted": count, "message": f"Deleted {count} unverified fighter(s) and their fight history"}

# ── Events ────────────────────────────────────────────────────────────────────

@app.get("/events")
async def get_events(limit: int = 50, offset: int = 0):
    response = db().table("events").select("*").order("date", desc=True).range(offset, offset + limit).execute()
    return response.data

@app.post("/events/scan")
async def scan_event(request: EventScanRequest, background_tasks: BackgroundTasks):
    pipeline = get_pipeline()
    background_tasks.add_task(pipeline.run_event_scan, request.event_name)
    return {"message": f"Event scan queued for: {request.event_name}", "status": "queued"}


@app.post("/events/cross-reference")
async def cross_reference_event(request: dict):
    """
    Read-only: resolves an event name → fight card → checks each fighter against DB.
    No DB writes. Returns bout-grouped exists/missing status for every fighter on the card.

    Response:
      { event_name, event_url, bouts: [{ fighter_a: { name, status, fighter_id }, fighter_b: ... }] }
    or on failure:
      { error: "...", event_name }
    """
    from app.scrapers.ufcstats_scraper import UFCStatsScraper
    from app.utils.search_utils import BraveSearch
    from app.utils.name_utils import normalize_name, find_fighter_by_name

    event_name = (request.get("event_name") or "").strip()
    if not event_name:
        from fastapi import HTTPException
        raise HTTPException(400, "event_name is required")

    scraper = UFCStatsScraper()
    search_tool = BraveSearch()
    supabase = db()

    event_url = scraper.find_event_url(event_name)
    if not event_url:
        results = search_tool.search(f"site:ufcstats.com {event_name}", count=5)
        for r in results:
            url = r.get("url", "")
            if "ufcstats.com/event-details/" in url:
                event_url = url
                break

    if not event_url:
        return {"error": "Event not found on UFCStats", "event_name": event_name}

    card_data = scraper.get_fight_card(event_url)
    bouts_raw = card_data.get("bouts", [])

    if not bouts_raw:
        return {
            "event_name": card_data.get("metadata", {}).get("event_name") or event_name,
            "event_url": event_url,
            "bouts": [],
        }

    resolved_event_name = card_data.get("metadata", {}).get("event_name") or event_name

    def check_fighter(name: str) -> dict:
        first, last = normalize_name(name)
        rec = find_fighter_by_name(supabase, first, last)
        return {
            "name": name,
            "status": "exists" if rec else "missing",
            "fighter_id": rec["id"] if rec else None,
        }

    bouts_out = []
    for bout in bouts_raw:
        bouts_out.append({
            "fighter_a": check_fighter(bout.get("fighter_a", "")),
            "fighter_b": check_fighter(bout.get("fighter_b", "")),
            "weight_class": bout.get("weight_class"),
        })

    return {
        "event_name": resolved_event_name,
        "event_url": event_url,
        "bouts": bouts_out,
    }


# ── News ──────────────────────────────────────────────────────────────────────

@app.get("/news")
async def get_news(limit: int = 20, offset: int = 0):
    response = db().table("news_articles").select("*").order("published_at", desc=True).range(offset, offset + limit).execute()
    return response.data

# ── Pipeline Jobs ─────────────────────────────────────────────────────────────

@app.get("/pipeline/jobs")
async def get_pipeline_jobs():
    from app.database import pipeline_queue as pq
    jobs = pq.get_all()

    # Enrich complete jobs with admin_status from Supabase so the UI can gate PUSH
    # to approved-only fighters without a separate API call per row.
    fighter_ids = list({
        j["fighter_id"] for j in jobs
        if j.get("status") == "complete" and j.get("fighter_id")
    })
    admin_status_map: dict[str, str] = {}
    if fighter_ids:
        try:
            res = (
                db()
                .table("fighters")
                .select("id, admin_status")
                .in_("id", fighter_ids)
                .execute()
            )
            for row in (res.data or []):
                admin_status_map[row["id"]] = row.get("admin_status") or "pending"
        except Exception as e:
            logger.warning(f"Could not fetch admin_status for jobs: {e}")

    for j in jobs:
        if j.get("fighter_id"):
            j["admin_status"] = admin_status_map.get(j["fighter_id"], "pending")
        else:
            j["admin_status"] = None

    return jobs

@app.post("/pipeline/retry/{fighter_name}")
async def retry_pipeline_job(fighter_name: str):
    """
    Force-retry a specific fighter job (resets to 'queued', clears attempt_count).
    The scheduler picks it up on the next tick (every 5 min).

    We do NOT spawn an immediate background task here — doing so risks concurrent
    processing if a scheduler tick starts while the manual task is still running.
    Instead, setting status='queued' is sufficient; the scheduler handles the rest.
    """
    from app.database import pipeline_queue as pq
    if not pq.fighter_exists(fighter_name):
        raise HTTPException(status_code=404, detail=f"No queue job found for '{fighter_name}'.")
    pq.retry_job(fighter_name)
    return {
        "message": f"Job for '{fighter_name}' reset to queued. The scheduler will process it on the next tick.",
        "fighter_name": fighter_name,
        "status": "queued",
    }

# ── Push endpoints ────────────────────────────────────────────────────────────

@app.post("/pipeline/process-queue")
async def trigger_process_queue(background_tasks: BackgroundTasks):
    """Manually trigger the queue processor (Agent 2 → 3 → 7 chain)."""
    def run():
        from app.agents.pipeline_manager import PipelineManager
        PipelineManager().process_queued_fighters()
    background_tasks.add_task(run)
    return {"message": "Queue processing triggered", "status": "queued"}

@app.post("/pipeline/push/fighter/{fighter_id}")
async def push_fighter(fighter_id: str):
    try:
        get_pipeline().push_to_main_app(fighter_id)
        return {"message": f"Fighter {fighter_id} pushed successfully", "status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/pipeline/push/news/{news_id}")
async def push_news(news_id: str):
    try:
        get_pipeline().push_news_to_main_app(news_id)
        return {"message": f"News item {news_id} pushed successfully", "status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ── Odds (Agent 6) ────────────────────────────────────────────────────────────

@app.get("/odds")
async def get_odds(status: Optional[str] = None, limit: int = 50, offset: int = 0):
    try:
        supabase = db()
        query = supabase.table("odds").select(
            "*, event_fights(weight_class, fighters!event_fights_fighter1_id_fkey(first_name, last_name), fighters!event_fights_fighter2_id_fkey(first_name, last_name))"
        ).order("pulled_at", desc=True)
        if status:
            query = query.eq("status", status)
        response = query.range(offset, offset + limit).execute()
        return response.data
    except Exception:
        return []

@app.post("/odds/pull")
async def trigger_odds_pull(background_tasks: BackgroundTasks):
    def run_pull():
        from app.agents.agent6_odds.agent import OddsAgent
        OddsAgent().run()
    background_tasks.add_task(run_pull)
    return {"message": "Odds pull triggered", "status": "queued"}

@app.patch("/odds/{odds_id}/approve")
async def approve_odds(odds_id: str):
    try:
        db().table("odds").update({"status": "approved"}).eq("id", odds_id).execute()
        return {"message": f"Odds {odds_id} approved", "status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.patch("/odds/{odds_id}/reject")
async def reject_odds(odds_id: str):
    try:
        db().table("odds").update({"status": "rejected"}).eq("id", odds_id).execute()
        return {"message": f"Odds {odds_id} rejected", "status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.delete("/odds/{odds_id}")
async def delete_odds(odds_id: str):
    try:
        db().table("odds").delete().eq("id", odds_id).execute()
        return {"message": f"Odds {odds_id} deleted", "status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ── Images (Agent 7) ──────────────────────────────────────────────────────────

@app.get("/images/bucket-status")
async def get_image_bucket_status():
    """
    Explicit check of the Supabase Storage fighter-images bucket.
    Returns exists, public, and action guidance if misconfigured.
    Used by Agent 7 on startup; also callable manually from the Images page.
    """
    try:
        buckets = db().storage.list_buckets()
        for bucket in buckets:
            name = bucket.get("name", "") if isinstance(bucket, dict) else getattr(bucket, "name", "")
            is_public = bucket.get("public", False) if isinstance(bucket, dict) else getattr(bucket, "public", False)
            if name == "fighter-images":
                return {
                    "bucket": "fighter-images",
                    "exists": True,
                    "public": is_public,
                    "ready": is_public,
                    "action": None if is_public else (
                        "Go to Supabase Dashboard → Storage → fighter-images → Edit → enable 'Public bucket'"
                    ),
                }
        return {
            "bucket": "fighter-images",
            "exists": False,
            "public": False,
            "ready": False,
            "action": (
                "Go to Supabase Dashboard → Storage → New bucket → "
                "name='fighter-images', Public=ON"
            ),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Cannot check storage bucket: {e}")

@app.get("/images/provider")
async def get_image_provider():
    """Returns the active image provider configuration and readiness status."""
    api_key_set = bool(os.environ.get("OPENAI_API_KEY"))
    return {
        "provider": "openai",
        "model": "dall-e-3",
        "headshot_size": "1024x1024",
        "half_body_size": "1024x1536",
        "images_generating": api_key_set,
        "dimensions_correct": True,
        "pipeline_connected": True,
        "api_key_set": api_key_set,
    }

@app.get("/images/pending")
async def get_pending_images(limit: int = 50, offset: int = 0):
    response = db().table("fighters").select(
        "id, first_name, last_name, weight_class, image_url, body_image_url, is_verified"
    ).is_("image_url", "null").range(offset, offset + limit).execute()
    return response.data

@app.get("/images/all")
async def get_all_fighter_images(limit: int = 100, offset: int = 0):
    supabase = db()
    # Try to fetch optional migration-011 columns; fall back if they don't exist yet
    try:
        response = supabase.table("fighters").select(
            "id, first_name, last_name, weight_class, image_url, body_image_url, "
            "needs_image, is_verified, image_source, ai_generated"
        ).range(offset, offset + limit).execute()
    except Exception:
        response = supabase.table("fighters").select(
            "id, first_name, last_name, weight_class, image_url, body_image_url, "
            "needs_image, is_verified"
        ).range(offset, offset + limit).execute()
    rows = response.data or []
    for row in rows:
        if row.get("image_url") and "via.placeholder.com" in row["image_url"]:
            row["image_url"] = None
        if row.get("body_image_url") and "via.placeholder.com" in row["body_image_url"]:
            row["body_image_url"] = None
        if row.get("needs_image") is True:
            row["image_url"] = None
    return rows

@app.post("/images/generate/{fighter_id}")
async def generate_fighter_image(fighter_id: str, background_tasks: BackgroundTasks):
    supabase = db()
    res = supabase.table("fighters").select("id, first_name, last_name").eq("id", fighter_id).single().execute()
    if not res.data:
        raise HTTPException(status_code=404, detail="Fighter not found")
    fighter = res.data
    fighter_name = f"{fighter['first_name']} {fighter['last_name']}".strip()

    def run_generation():
        from app.agents.agent7_image.agent import ImageAgent
        ImageAgent().run(fighter["id"], fighter_name)

    background_tasks.add_task(run_generation)
    return {"message": f"Image generation queued for {fighter_name}", "status": "queued"}

def _needs_image(url: str | None) -> bool:
    if not url:
        return True
    return "via.placeholder.com" in url

@app.post("/images/generate-all")
async def generate_all_pending_images(background_tasks: BackgroundTasks):
    supabase = db()
    res = supabase.table("fighters").select(
        "id, first_name, last_name, image_url, body_image_url, needs_image"
    ).execute()
    all_fighters = res.data or []
    fighters = [
        f for f in all_fighters
        if f.get("needs_image") is True
        or _needs_image(f.get("image_url"))
        or _needs_image(f.get("body_image_url"))
    ]

    def run_all():
        from app.agents.agent7_image.agent import ImageAgent
        agent = ImageAgent()
        for f in fighters:
            try:
                name = f"{f['first_name']} {f['last_name']}".strip()
                agent.run(f["id"], name)
            except Exception as e:
                print(f"Image gen failed for {f.get('first_name')} {f.get('last_name')}: {e}")

    background_tasks.add_task(run_all)
    return {"message": f"Bulk image generation queued for {len(fighters)} fighters", "status": "queued"}

@app.patch("/images/clear/{fighter_id}")
async def clear_fighter_image(fighter_id: str):
    try:
        db().table("fighters").update({
            "image_url": None,
            "body_image_url": None,
        }).eq("id", fighter_id).execute()
        return {"message": "Images cleared", "status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

def _process_image(image_bytes: bytes, image_type: str) -> dict:
    """
    Resizes and crops image to mandated specifications using Pillow.
    Returns a dict of { filename: bytes }.
    - headshot  -> 512x512 (main), 128x128 (thumb), 64x64 (mini)
    - body_shot -> 600x800
    """
    try:
        img = Image.open(io.BytesIO(image_bytes))
        if img.mode in ("RGBA", "P"):
            img = img.convert("RGB")

        results = {}

        if image_type == "headshot":
            # Center crop to square
            w, h = img.size
            size = min(w, h)
            left = (w - size) // 2
            top = (h - size) // 2
            img = img.crop((left, top, left + size, top + size))
            
            # Main: 512x512
            main = img.resize((512, 512), Image.Resampling.LANCZOS)
            out = io.BytesIO()
            main.save(out, format="JPEG", quality=90)
            results["headshot.jpg"] = out.getvalue()

            # Thumb: 128x128
            thumb = img.resize((128, 128), Image.Resampling.LANCZOS)
            out = io.BytesIO()
            thumb.save(out, format="JPEG", quality=85)
            results["headshot_128.jpg"] = out.getvalue()

            # Mini: 64x64
            mini = img.resize((64, 64), Image.Resampling.LANCZOS)
            out = io.BytesIO()
            mini.save(out, format="JPEG", quality=80)
            results["headshot_64.jpg"] = out.getvalue()

        else: # body_shot
            # 600:800 aspect ratio crop
            target_ratio = 600 / 800
            w, h = img.size
            current_ratio = w / h
            
            if current_ratio > target_ratio:
                new_w = int(h * target_ratio)
                left = (w - new_w) // 2
                img = img.crop((left, 0, left + new_w, h))
            else:
                new_h = int(w / target_ratio)
                top = (h - new_h) // 2
                img = img.crop((0, top, w, top + new_h))
                
            body = img.resize((600, 800), Image.Resampling.LANCZOS)
            out = io.BytesIO()
            body.save(out, format="JPEG", quality=85)
            results["half-body.jpg"] = out.getvalue()

        return results
    except Exception as e:
        logger.error(f"Image processing failed: {e}")
        return {}

@app.post("/images/upload/{fighter_id}")
async def upload_fighter_image(
    fighter_id: str,
    image: UploadFile = File(...),
    image_type: str = Form(...),
):
    """
    Operator manual image upload endpoint.

    Accepts multipart/form-data with:
      - image:      the image file (any common image format)
      - image_type: "headshot" or "body_shot"

    Uploads the file to Supabase Storage under fighter-images/{fighter_id}/:
      headshot  → headshot.jpg  (updates image_url)
      body_shot → half-body.jpg (updates body_image_url)

    Returns { url, image_type } on success.
    """
    if image_type not in ("headshot", "body_shot"):
        raise HTTPException(status_code=400, detail="image_type must be 'headshot' or 'body_shot'.")

    # Verify fighter exists
    res = db().table("fighters").select("id, first_name, last_name").eq("id", fighter_id).single().execute()
    if not res.data:
        raise HTTPException(status_code=404, detail=f"Fighter {fighter_id} not found.")

    image_bytes = await image.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")

    processed = _process_image(image_bytes, image_type)
    if not processed:
        raise HTTPException(status_code=500, detail="Failed to process image.")

    _STORAGE_BUCKET = "fighter-images"
    supabase = db()
    public_url = ""

    try:
        for filename, bts in processed.items():
            storage_path = f"{fighter_id}/{filename}"
            try:
                supabase.storage.from_(_STORAGE_BUCKET).upload(
                    storage_path, bts,
                    {"content-type": "image/jpeg", "upsert": "true"}
                )
            except Exception:
                supabase.storage.from_(_STORAGE_BUCKET).update(
                    storage_path, bts, {"content-type": "image/jpeg"}
                )
            # Use headshot.jpg or half-body.jpg for the main DB URL
            if filename in ("headshot.jpg", "half-body.jpg"):
                public_url = supabase.storage.from_(_STORAGE_BUCKET).get_public_url(storage_path)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Storage upload failed: {e}")

    db_field = "image_url" if image_type == "headshot" else "body_image_url"
    db_extras = {"needs_image": False, "image_source": "manual"} if image_type == "headshot" else {"ai_generated": False}

    updates = {db_field: public_url, **db_extras}
    try:
        db().table("fighters").update(updates).eq("id", fighter_id).execute()
    except Exception as e:
        if "image_source" in str(e) or "ai_generated" in str(e):
            db().table("fighters").update({db_field: public_url}).eq("id", fighter_id).execute()
        else:
            raise HTTPException(status_code=500, detail=f"DB update failed: {e}")

    logger.info(f"Processed manual upload: {image_type} for {fighter_id} → {public_url}")
    return {"url": public_url, "image_type": image_type}

# ── Pipeline Review Dashboard ──────────────────────────────────────────────────
# All endpoints for the admin pipeline review UI.
# Requires Migration 005 to be applied for admin_status columns + activity_log table.

# ── Event Fight Reconciliation ─────────────────────────────────────────────────

@app.get("/pipeline/review/counts")
async def get_review_counts():
    """Returns record counts per status and type for dashboard tab badges."""
    supabase = db()
    from datetime import date
    today = date.today().isoformat()

    def safe(fn):
        try:
            r = fn()
            return r.count or 0
        except Exception:
            return 0

    # Fighters
    pending_f   = safe(lambda: supabase.table("fighters").select("count", count="exact").eq("admin_status", "pending").execute())
    approved_f  = safe(lambda: supabase.table("fighters").select("count", count="exact").eq("admin_status", "approved").execute())
    rejected_f  = safe(lambda: supabase.table("fighters").select("count", count="exact").eq("admin_status", "rejected").execute())

    # News
    pending_n   = safe(lambda: supabase.table("news_articles").select("count", count="exact").eq("admin_status", "pending").execute())
    approved_n  = safe(lambda: supabase.table("news_articles").select("count", count="exact").eq("admin_status", "approved").execute())
    rejected_n  = safe(lambda: supabase.table("news_articles").select("count", count="exact").eq("admin_status", "rejected").execute())

    # Odds
    pending_o   = safe(lambda: supabase.table("odds").select("count", count="exact").eq("status", "staging").execute())
    approved_o  = safe(lambda: supabase.table("odds").select("count", count="exact").eq("status", "approved").execute())
    rejected_o  = safe(lambda: supabase.table("odds").select("count", count="exact").eq("status", "rejected").execute())

    # Needs attention — fighters missing both images
    needs_img   = safe(lambda: supabase.table("fighters").select("count", count="exact").is_("body_image_url", "null").execute())

    pushed_today = safe(lambda: supabase.table("activity_log").select("count", count="exact")
                        .eq("action", "pushed").gte("created_at", f"{today}T00:00:00").execute())
    approved_today = safe(lambda: supabase.table("activity_log").select("count", count="exact")
                          .eq("action", "approved").gte("created_at", f"{today}T00:00:00").execute())
    rejected_today = safe(lambda: supabase.table("activity_log").select("count", count="exact")
                          .eq("action", "rejected").gte("created_at", f"{today}T00:00:00").execute())

    try:
        last_log = supabase.table("activity_log").select("created_at").order("created_at", desc=True).limit(1).execute()
        last_activity = last_log.data[0]["created_at"] if last_log.data else None
    except Exception:
        last_activity = None

    return {
        "pending":  {"fighters": pending_f,  "news": pending_n,  "odds": pending_o},
        "approved": {"fighters": approved_f, "news": approved_n, "odds": approved_o},
        "rejected": {"fighters": rejected_f, "news": rejected_n, "odds": rejected_o},
        "needs_attention": needs_img,
        "today":    {"pushed": pushed_today, "approved": approved_today, "rejected": rejected_today},
        "last_activity": last_activity,
    }


@app.get("/pipeline/review/fighters")
async def get_review_fighters(status: str = "pending", limit: int = 100, offset: int = 0):
    """Fetch fighters by admin_status for the review dashboard."""
    supabase = db()
    try:
        res = (
            supabase.table("fighters")
            .select("*")
            .eq("admin_status", status)
            .order("created_at", desc=True)
            .range(offset, offset + limit)
            .execute()
        )
        return res.data or []
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/pipeline/review/fighters/{fighter_id}")
async def get_review_fighter_detail(fighter_id: str):
    """Fetch full fighter record including fight history for the preview panel."""
    supabase = db()
    try:
        f = supabase.table("fighters").select("*").eq("id", fighter_id).single().execute()
        if not f.data:
            raise HTTPException(status_code=404, detail="Fighter not found")

        history = (
            supabase.table("fight_history")
            .select("*")
            .eq("fighter_id", fighter_id)
            .order("event_date", desc=True)
            .execute()
        )
        return {"fighter": f.data, "fight_history": history.data or []}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.patch("/pipeline/review/fighters/{fighter_id}/approve")
async def approve_fighter(fighter_id: str, background_tasks: BackgroundTasks):
    """Approve a fighter record: sets admin_status=approved, pushes to main app."""
    supabase = db()
    try:
        supabase.table("fighters").update({
            "admin_status": "approved",
            "is_verified":  True,
            "reviewed_at":  "now()",
        }).eq("id", fighter_id).execute()

        supabase.table("activity_log").insert({
            "agent_name":  "Admin",
            "action":      "approved",
            "entity_type": "fighter",
            "entity_id":   fighter_id,
            "status":      "success",
            "detail":      "Fighter approved via admin dashboard",
        }).execute()

        background_tasks.add_task(get_pipeline().push_to_main_app, fighter_id)
        return {"status": "approved", "fighter_id": fighter_id}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.patch("/pipeline/review/fighters/{fighter_id}/reject")
async def reject_fighter(fighter_id: str):
    """Reject a fighter record: sets admin_status=rejected."""
    supabase = db()
    try:
        supabase.table("fighters").update({
            "admin_status": "rejected",
            "reviewed_at":  "now()",
        }).eq("id", fighter_id).execute()

        supabase.table("activity_log").insert({
            "agent_name":  "Admin",
            "action":      "rejected",
            "entity_type": "fighter",
            "entity_id":   fighter_id,
            "status":      "success",
            "detail":      "Fighter rejected via admin dashboard",
        }).execute()

        return {"status": "rejected", "fighter_id": fighter_id}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.patch("/pipeline/review/fighters/{fighter_id}/restore")
async def restore_fighter(fighter_id: str):
    """Move a rejected fighter back to pending."""
    supabase = db()
    try:
        supabase.table("fighters").update({"admin_status": "pending"}).eq("id", fighter_id).execute()
        return {"status": "pending", "fighter_id": fighter_id}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class FighterEditPayload(BaseModel):
    fields: Dict[str, str]

@app.put("/pipeline/review/fighters/{fighter_id}")
async def edit_fighter(fighter_id: str, payload: FighterEditPayload):
    """Update specific fighter fields from the admin edit form."""
    ALLOWED_FIGHTER_FIELDS = {
        "first_name", "last_name", "nickname", "weight_class", "nationality",
        "height_in", "reach_in", "stance", "gym", "team", "head_coach",
        "fighting_out_of", "twitter_handle", "instagram_handle", "bio",
        "fighting_style", "status",
    }
    invalid = [k for k in payload.fields if k not in ALLOWED_FIGHTER_FIELDS]
    if invalid:
        raise HTTPException(status_code=400, detail=f"Disallowed fields: {invalid}")
    try:
        db().table("fighters").update(payload.fields).eq("id", fighter_id).execute()
        return {"status": "updated", "fighter_id": fighter_id}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/pipeline/review/news")
async def get_review_news(status: str = "pending", limit: int = 100, offset: int = 0):
    """Fetch news articles by admin_status for the review dashboard."""
    supabase = db()
    try:
        res = (
            supabase.table("news_articles")
            .select("*")
            .eq("admin_status", status)
            .order("created_at", desc=True)
            .range(offset, offset + limit)
            .execute()
        )
        return res.data or []
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.patch("/pipeline/review/news/{news_id}/approve")
async def approve_news(news_id: str, background_tasks: BackgroundTasks):
    supabase = db()
    try:
        supabase.table("news_articles").update({
            "admin_status": "approved",
            "is_published":  True,
            "reviewed_at":  "now()",
        }).eq("id", news_id).execute()
        supabase.table("activity_log").insert({
            "agent_name":  "Admin",
            "action":      "approved",
            "entity_type": "news",
            "entity_id":   news_id,
            "status":      "success",
        }).execute()
        background_tasks.add_task(get_pipeline().push_news_to_main_app, news_id)
        return {"status": "approved", "news_id": news_id}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.patch("/pipeline/review/news/{news_id}/reject")
async def reject_news(news_id: str):
    supabase = db()
    try:
        supabase.table("news_articles").update({
            "admin_status": "rejected",
            "reviewed_at":  "now()",
        }).eq("id", news_id).execute()
        supabase.table("activity_log").insert({
            "agent_name":  "Admin",
            "action":      "rejected",
            "entity_type": "news",
            "entity_id":   news_id,
            "status":      "success",
        }).execute()
        return {"status": "rejected", "news_id": news_id}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class NewsEditPayload(BaseModel):
    fields: Dict[str, str]

@app.put("/pipeline/review/news/{news_id}")
async def edit_news(news_id: str, payload: NewsEditPayload):
    ALLOWED_NEWS_FIELDS = {"headline", "summary", "title", "content", "subtitle", "layer", "signal_type", "tags", "topic_tags", "author"}
    invalid = [k for k in payload.fields if k not in ALLOWED_NEWS_FIELDS]
    if invalid:
        raise HTTPException(status_code=400, detail=f"Disallowed fields: {invalid}")
    try:
        db().table("news_articles").update(payload.fields).eq("id", news_id).execute()
        return {"status": "updated", "news_id": news_id}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/pipeline/review/needs-attention")
async def get_needs_attention(limit: int = 100):
    """Records that require admin action: missing body images."""
    supabase = db()
    try:
        needs_img = supabase.table("fighters").select(
            "id, first_name, last_name, weight_class, image_url, body_image_url, admin_status"
        ).is_("body_image_url", "null").limit(limit).execute()

        return {
            "needs_image": needs_img.data or [],
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/pipeline/activity-log")
async def get_activity_log(
    limit: int = 100,
    offset: int = 0,
    agent_name: Optional[str] = None,
    status: Optional[str] = None,
    entity_type: Optional[str] = None,
    search: Optional[str] = None,
):
    """Fetch the pipeline activity log with optional filters."""
    supabase = db()
    try:
        q = supabase.table("activity_log").select("*").order("created_at", desc=True)
        if agent_name:
            q = q.eq("agent_name", agent_name)
        if status:
            q = q.eq("status", status)
        if entity_type:
            q = q.eq("entity_type", entity_type)
        if search:
            q = q.ilike("entity_name", f"%{search}%")
        q = q.range(offset, offset + limit)
        res = q.execute()
        return res.data or []
    except Exception as e:
        return []


# ── Event Fight Reconciliation Endpoints ───────────────────────────────────────

@app.get("/events/reconcile/{event_id}")
async def reconcile_event(event_id: str):
    """
    Reconcile event fight pairings for a specific event.
    Creates missing event_fights records where both fighters now exist in DB.
    Returns reconciliation result with counts and details.
    """
    from app.services.event_fight_reconciler import reconcile_event_endpoint
    result = reconcile_event_endpoint(event_id)
    if "error" in result:
        raise HTTPException(status_code=404, detail=result["error"])
    return result


@app.post("/events/reconcile/all")
async def reconcile_all_events():
    """
    Reconcile all upcoming events.
    Scans each upcoming event and creates missing event_fights records.
    Returns list of reconciliation results for all events.
    """
    from app.services.event_fight_reconciler import reconcile_all_events_endpoint
    results = reconcile_all_events_endpoint()
    return {"results": results, "count": len(results)}


@app.get("/events/check-completeness/{event_id}")
async def check_event_completeness(event_id: str):
    """
    Check completeness status for an event without modifying data.
    Returns expected vs actual fight count, missing bouts, and fighter availability.
    """
    from app.services.event_fight_reconciler import get_event_completeness_endpoint
    result = get_event_completeness_endpoint(event_id)
    if "error" in result:
        raise HTTPException(status_code=404, detail=result["error"])
    return result


@app.get("/events/completeness-report")
async def get_all_events_completeness_report():
    """
    Get completeness report for all upcoming events.
    Returns list of events with their completeness status and missing bouts.
    """
    supabase = db()
    from app.services.event_fight_reconciler import EventFightReconciler
    
    reconciler = EventFightReconciler()
    
    # Get all upcoming events
    events_res = supabase.table("events").select("id, name").eq("status", "Upcoming").execute()
    
    reports = []
    for event in (events_res.data or []):
        report = reconciler.get_event_completeness(event["id"])
        reports.append(report)
    
    # Sort by completeness (incomplete first)
    reports.sort(key=lambda r: (r.get("is_complete", False), r.get("event_name", "")))
    
    return {
        "reports": reports,
        "total_events": len(reports),
        "complete_count": sum(1 for r in reports if r.get("is_complete")),
        "incomplete_count": sum(1 for r in reports if not r.get("is_complete")),
    }


@app.post("/pipeline/activity-log")
async def log_activity(entry: dict):
    """Write a single activity log entry (called by pipeline agents)."""
    supabase = db()
    try:
        allowed = {"agent_name", "action", "entity_type", "entity_id", "entity_name", "status", "detail"}
        clean = {k: v for k, v in entry.items() if k in allowed}
        supabase.table("activity_log").insert(clean).execute()
        return {"status": "logged"}
    except Exception as e:
        return {"status": "error", "detail": str(e)}


if __name__ == "__main__":
    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=True)
