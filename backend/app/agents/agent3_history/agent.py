import json
from datetime import datetime
from app.database.supabase_client import get_supabase
from app.database import pipeline_queue as pq
from app.scrapers.sherdog_scraper import SherdogScraper
from app.utils.search_utils import BraveSearch
from app.utils.claude_utils import get_claude, ClaudeEmptyResponseError
from app.utils.firecrawl_utils import scrape_url
from app.prompts import HISTORY_BRIEF_PROMPT


def _parse_to_seconds(time_str: str) -> int:
    if not time_str or ":" not in time_str:
        return 0
    try:
        m, s = map(int, time_str.split(":"))
        return m * 60 + s
    except Exception:
        return 0


class HistoryAgent:
    """
    Agent 3 — History Builder.

    Scrapes fight history from Sherdog, stores it with ON CONFLICT dedup,
    and generates an AI Brief using Claude.

    No CrewAI dependency — runs as plain Python.
    """

    def __init__(self):
        self.supabase = get_supabase()
        self.scraper = SherdogScraper()
        self.search = BraveSearch()
        self.claude = get_claude()

    def run(self, fighter_id: str, fighter_name: str) -> str:
        """
        Scrapes fight history from Sherdog, records it in fight_history
        (ON CONFLICT DO UPDATE dedup), and generates an AI Brief using Claude.

        Data source: sherdog.com (accessible, validated selectors).
        Tapology is Cloudflare-protected and cannot be scraped.
        """
        # 1. Update queue status
        pq.update_status(fighter_name, "history")

        # 2. Get job info for event_id and event metadata
        job = pq.get_job(fighter_name)
        event_id = job.get("event_id", "")
        event_name = job.get("event_name", "")
        event_date = job.get("event_date", "") or datetime.now().strftime("%Y-%m-%d")

        # 3. Find Sherdog profile URL via Brave Search
        results = self.search.search(f"site:sherdog.com {fighter_name} fighter", count=3)
        fighter_url = None
        for r in results:
            url = r.get("url", "")
            if "sherdog.com/fighter/" in url:
                fighter_url = url
                break

        if not fighter_url:
            print(f"[Agent3] Could not find Sherdog URL for {fighter_name}. Skipping history.")
            pq.update_status(fighter_name, "complete")
            return f"No Sherdog URL found for {fighter_name}."

        # 4. Scrape bouts via BeautifulSoup
        bouts = self.scraper.get_fighter_history(fighter_url)

        # 4b. If scraper returned no bouts, try Firecrawl as fallback
        if not bouts:
            print(f"[Agent3] BeautifulSoup returned 0 bouts — trying Firecrawl for {fighter_url}")
            fc_text = scrape_url(fighter_url)
            if fc_text:
                print(f"[Agent3] Firecrawl got {len(fc_text)} chars — Claude will extract bouts from markdown")
                bouts = [{"_firecrawl_raw": fc_text[:8000], "fighter_name": fighter_name}]

        # 5. Validate with Claude BEFORE any DB writes.
        # If Claude fails, no fight_history rows or bio are written — the queue
        # is marked "error" so the operator can retry the whole agent cleanly.
        bouts_summary = "; ".join(
            f"{b.get('result','?')} vs {b.get('opponent_name','?')} via {b.get('method','?')}"
            for b in bouts[:10]
        )
        user_content = f"Fighter: {fighter_name}\nRecent bouts: {bouts_summary}"
        try:
            ai_brief = self.claude.analyze(
                HISTORY_BRIEF_PROMPT,
                user_content,
                required_keys=["fighting_style", "recent_trend"],
            )
        except ClaudeEmptyResponseError as e:
            print(
                f"[Agent3] Claude AI Brief failed for {fighter_name}. "
                f"No DB writes made. Marking queue as error. Details: {e}"
            )
            pq.update_status(fighter_name, "error")
            return (
                f"Claude AI Brief failed for {fighter_name}. "
                f"No history rows written. Queue marked as error."
            )

        # 6. Claude succeeded — batch upsert all bouts with ON CONFLICT dedup.
        # ON CONFLICT (fighter_id, event_name, opponent_name) DO UPDATE ensures
        # that re-running Agent 3 on the same fighter never creates duplicate rows.
        rows = []
        for idx, bout in enumerate(bouts):
            title_fight = bout.get("title_fight", False)
            fight_type = bout.get("fight_type") or ("Title Bout" if title_fight else "Bout")

            raw_location = bout.get("location")
            if isinstance(raw_location, dict):
                location = raw_location
            elif isinstance(raw_location, str):
                try:
                    location = json.loads(raw_location)
                except Exception:
                    location = {"raw": raw_location}
            else:
                location = {}

            time_str = bout.get("time") or "0:00"
            round_num = bout.get("round") or 1
            fight_date = bout.get("date") or bout.get("fight_date") or event_date
            fight_event_name = bout.get("event_name") or event_name

            rows.append({
                "fighter_id": fighter_id,
                "event_id": event_id if event_id else None,
                "event_name": fight_event_name or "Unknown Event",
                "event_date": fight_date,
                "event_promotion": bout.get("event_promotion") or bout.get("promotion"),
                "fighter_name": fighter_name,
                "opponent_name": bout.get("opponent_name") or "Unknown",
                "result": bout.get("result") or "NC",
                "method": bout.get("method") or "Unknown",
                "method_detail": bout.get("method_detail"),
                "referee": bout.get("referee"),
                "round": round_num,
                "time": time_str,
                "rounds_scheduled": bout.get("rounds_scheduled"),
                "fight_duration_seconds": _parse_to_seconds(time_str) + (round_num - 1) * 300,
                "title_fight": title_fight,
                "fight_type": fight_type,
                "weight_class": bout.get("weight_class") or "Unknown",
                "billing": bout.get("billing"),
                "bout_order": bout.get("bout_order") or (idx + 1),
                "location": location,
            })

        stored = 0
        if rows:
            try:
                self.supabase.table("fight_history").upsert(
                    rows,
                    on_conflict="fighter_id,event_name,opponent_name",
                ).execute()
                stored = len(rows)
                print(f"[Agent3] Upserted {stored} bouts for {fighter_name}.")
            except Exception as e:
                print(f"[Agent3] Batch upsert failed for {fighter_name}: {e}")

        # 7. Write the AI Brief to fighters.bio
        try:
            bio_text = json.dumps(ai_brief) if isinstance(ai_brief, dict) else str(ai_brief)
            self.supabase.table("fighters").update({
                "bio": bio_text,
            }).eq("id", fighter_id).execute()
            print(f"[Agent3] AI Brief stored for {fighter_name}.")
        except Exception as e:
            print(f"[Agent3] Error writing AI Brief to DB for {fighter_name}: {e}")
            pq.update_status(fighter_name, "error")
            return f"History stored ({stored} bouts) but AI Brief DB write failed for {fighter_name}."

        # 8. Mark complete
        pq.update_status(fighter_name, "complete")

        return f"History ({stored} bouts from Sherdog) and AI Brief completed for {fighter_name}."
