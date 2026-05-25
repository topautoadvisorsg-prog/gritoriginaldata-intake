import os
import ssl
import requests
import urllib3
from app.agents.agent1_event.agent import EventAgent
from app.agents.agent2_profile.agent import ProfileAgent
from app.agents.agent3_history.agent import HistoryAgent
from app.agents.agent7_image.agent import ImageAgent
from app.database.supabase_client import get_supabase
from app.database import pipeline_queue as pq
from app.utils.name_utils import normalize_name, find_fighter_by_name

WEBHOOK_PATH = "/api/data-engine/webhook"

# ── Manual Ingestion Mode ──────────────────────────────────────────────────────
# When True: scraping-based pipeline (Agents 1, 2, 3) is DISABLED.
# Operator uses POST /ingest/raw + /ingest/approve instead.
# News and Odds scrapers are NOT affected — they continue running normally.
# Set to False to re-enable automated scraping once data quality is confirmed.
MANUAL_INGESTION_MODE = True

# Replit's TLS cert isn't in certifi's bundle; use the system CA store instead.
# This is safe for our internal Replit-to-Replit calls.
_SSL_VERIFY = ssl.get_default_verify_paths().cafile or False
if not _SSL_VERIFY:
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

class PipelineManager:
    def __init__(self):
        self._supabase = None
        self._event_agent = None
        self._profile_agent = None
        self._history_agent = None
        self._image_agent = None
        self.api_key = os.getenv("DATA_ENGINE_API_KEY")

    @property
    def event_agent(self):
        if self._event_agent is None:
            self._event_agent = EventAgent()
        return self._event_agent

    @property
    def profile_agent(self):
        if self._profile_agent is None:
            self._profile_agent = ProfileAgent()
        return self._profile_agent

    @property
    def history_agent(self):
        if self._history_agent is None:
            self._history_agent = HistoryAgent()
        return self._history_agent

    @property
    def image_agent(self):
        if self._image_agent is None:
            self._image_agent = ImageAgent()
        return self._image_agent

    @property
    def supabase(self):
        if self._supabase is None:
            self._supabase = get_supabase()
        return self._supabase

    @property
    def main_app_url(self):
        return os.getenv("MAIN_APP_API_URL", "").rstrip("/")

    def _webhook_url(self) -> str:
        return f"{self.main_app_url}{WEBHOOK_PATH}"

    def _headers(self) -> dict:
        return {
            "Content-Type": "application/json",
            "x-api-key": self.api_key,
        }

    def run_event_scan(self, event_name: str, event_url: str = ""):
        if MANUAL_INGESTION_MODE:
            print(
                "[Pipeline] MANUAL_INGESTION_MODE=True — "
                "event scan (Agent 1) is DISABLED. "
                "Use POST /ingest/raw to add fighters manually."
            )
            return {"status": "disabled", "reason": "Manual ingestion mode active"}
        return self.event_agent.run(event_name, event_url=event_url)

    def process_queued_fighters(self):
        if MANUAL_INGESTION_MODE:
            print(
                "[Pipeline] MANUAL_INGESTION_MODE=True — "
                "queue processing (Agents 2+3) is DISABLED. "
                "Use POST /ingest/raw + /ingest/approve instead."
            )
            return
        queued = pq.get_queued()
        for job in queued:
            self._process_single_fighter(job["fighter_name"])

    def _process_single_fighter(self, fighter_name: str):
        """
        Run the full pipeline (Agent 2 → Agent 7 → Agent 3) for one fighter.

        Any exception at any stage is caught here — the error message is written
        to the queue job via pq.fail_job() so it is visible in the Monitor UI.
        If the fighter has fewer than MAX_ATTEMPTS failures, the job is re-queued
        automatically; otherwise it moves to "failed" and waits for a manual retry.
        """
        try:
            result2 = self.profile_agent.run(fighter_name)

            # Agent 2 sets status="error" and returns an error string if it fails
            # (e.g. Brave Search timeout, Sherdog 403, Claude empty response).
            # Detect this and route through fail_job so retry logic fires.
            job = pq.get_job(fighter_name)
            if job.get("status") == "error":
                pq.fail_job(
                    fighter_name,
                    result2 or "Agent 2 (Profile) set status=error — see logs for details.",
                )
                return

            fighter_id = job.get("fighter_id")

            if not fighter_id:
                first_name, last_name = normalize_name(fighter_name)
                fighter_rec = find_fighter_by_name(self.supabase, first_name, last_name)
                if fighter_rec:
                    fighter_id = fighter_rec["id"]
                    pq.update_status(fighter_name, "profiling", fighter_id=fighter_id)

            if not fighter_id:
                pq.fail_job(
                    fighter_name,
                    "Agent 2 completed but no fighter_id found in queue or DB. "
                    "Profile may not have been saved correctly.",
                )
                return

            # Agent 7 (image generation) is DISABLED — images are handled manually
            # by the operator via the Images tab upload workflow.
            # Update status to skip past the imaging step cleanly.
            pq.update_status(fighter_name, "imaging")
            print(f"[Pipeline] Agent 7 SKIPPED for {fighter_name} — manual image upload mode.")

            result3 = self.history_agent.run(fighter_id, fighter_name)

            # Agent 3 also sets status="error" on Claude failures.
            job = pq.get_job(fighter_name)
            if job.get("status") == "error":
                pq.fail_job(
                    fighter_name,
                    result3 or "Agent 3 (History) set status=error — see logs for details.",
                )
                return

            # Fighter stays in admin_status='pending' — admin must approve via
            # the review dashboard before anything is pushed to the GRIT main app.
            print(f"[Pipeline] {fighter_name} processed and queued for admin review.")

        except Exception as exc:
            error_msg = str(exc)
            print(f"[Pipeline] ERROR processing {fighter_name}: {error_msg}")
            pq.fail_job(fighter_name, error_msg)

    # ── Push: Fighter ─────────────────────────────────────────────────────────

    def push_to_main_app(self, fighter_id: str):
        """
        Pushes a fighter record to the GRIT main app via the single webhook endpoint.
        """
        if not self.main_app_url:
            print("MAIN_APP_API_URL not set. Skipping push.")
            return

        res = self.supabase.table("fighters").select("*").eq("id", fighter_id).single().execute()
        if not res.data:
            return

        fighter_data = res.data
        first_name = fighter_data.get("first_name", "")
        last_name = fighter_data.get("last_name", "")

        grit_id = self.discover_fighter_id(first_name, last_name)
        action_type = "update" if grit_id else "create"

        mapped_data = self._map_fighter_to_v2_spec(fighter_data)

        payload = {
            "sourceType": "fighter",
            "actionType": action_type,
            "dataType": "mma_data",
            "data": mapped_data,
        }
        if action_type == "update" and grit_id:
            payload["sourceId"] = grit_id

        try:
            response = requests.post(
                self._webhook_url(),
                json=payload,
                headers=self._headers(),
                timeout=15,
                verify=_SSL_VERIFY,
            )
            response.raise_for_status()
            print(f"Successfully pushed fighter {fighter_id} to GRIT as {action_type}.")

            if not grit_id:
                grit_id = self.discover_fighter_id(first_name, last_name)

            if grit_id:
                self.push_fight_history(fighter_id, grit_id)

        except Exception as e:
            print(f"Error pushing fighter to GRIT: {e}")

    # ── Push: Fight History ───────────────────────────────────────────────────

    def push_fight_history(self, local_fighter_id: str, grit_uuid: str):
        """
        Pushes ALL historical bouts for a fighter to GRIT.
        Each bout is sent as a separate POST (sourceType=fight, actionType=create)
        because the main app does not support batch fight ingestion.

        eventId uses the data engine's internal event UUID when available;
        historical fights without a linked event send a nil UUID so the main
        app queues the record for admin review instead of auto-applying.
        """
        import json as _json
        NIL_UUID = "00000000-0000-0000-0000-000000000000"

        res = self.supabase.table("fight_history").select("*").eq("fighter_id", local_fighter_id).execute()
        if not res.data:
            return

        success = 0
        queued = 0
        errors = 0

        for bout in res.data:
            title_fight = bout.get("title_fight", False)
            fight_type = "Title Bout" if title_fight else "Bout"

            location = bout.get("location")
            if isinstance(location, str):
                try:
                    location = _json.loads(location)
                except Exception:
                    location = None

            raw_date = bout.get("event_date")
            if raw_date:
                date_str = str(raw_date)
                if "T" not in date_str:
                    date_str = date_str + "T00:00:00Z"
                elif not date_str.endswith("Z") and "+" not in date_str:
                    date_str = date_str + "Z"
            else:
                date_str = None

            event_id = bout.get("event_id") or NIL_UUID

            payload = {
                "sourceType": "fight",
                "actionType": "create",
                "dataType": "mma_data",
                "data": {
                    "fighterId": grit_uuid,
                    "eventId": event_id,
                    "opponentName": bout.get("opponent_name"),
                    "eventName": bout.get("event_name"),
                    "eventDate": date_str,
                    "eventPromotion": bout.get("event_promotion"),
                    "result": bout.get("result"),
                    "method": bout.get("method"),
                    "methodDetail": bout.get("method_detail"),
                    "referee": bout.get("referee"),
                    "round": bout.get("round"),
                    "time": bout.get("time"),
                    "roundsScheduled": bout.get("rounds_scheduled"),
                    "weightClass": bout.get("weight_class"),
                    "titleFight": title_fight,
                    "fightType": fight_type,
                    "billing": bout.get("billing"),
                    "boutOrder": bout.get("bout_order"),
                    "fightDurationSeconds": bout.get("fight_duration_seconds", 0),
                    "location": location if isinstance(location, dict) else {},
                },
            }

            try:
                response = requests.post(
                    self._webhook_url(),
                    json=payload,
                    headers=self._headers(),
                    timeout=15,
                    verify=_SSL_VERIFY,
                )
                if response.status_code in (200, 201):
                    success += 1
                elif response.status_code in (202, 207):
                    queued += 1
                    print(f"[Push] Fight queued for review: {bout.get('opponent_name')} — {response.text[:120]}")
                else:
                    errors += 1
                    print(f"[Push] Fight push unexpected status {response.status_code}: {response.text[:200]}")
            except Exception as e:
                errors += 1
                print(f"[Push] Error pushing fight vs {bout.get('opponent_name')}: {e}")

        print(
            f"[Push] Fight history for {local_fighter_id} (Grit: {grit_uuid}): "
            f"{success} applied, {queued} queued, {errors} errors "
            f"(total: {len(res.data)})"
        )

    # ── Push: Odds ────────────────────────────────────────────────────────────

    def push_odds(self, fight_card_id: str):
        """
        Pushes ALL odds for a fight card to GRIT in a single batch request.
        """
        res = self.supabase.table("odds").select("*").eq("fight_card_id", fight_card_id).execute()
        if not res.data:
            return

        odds_list = []
        for o in res.data:
            odds_list.append({
                "fighter1Odds": o["fighter_a_line"],
                "fighter2Odds": o["fighter_b_line"],
                "overUnder": o.get("over_under"),
                "source": o.get("source", "BestFightOdds"),
            })

        payload = {
            "sourceType": "odds",
            "actionType": "batch_create",
            "dataType": "mma_data",
            "data": {
                "fightCardId": fight_card_id,
                "odds": odds_list
            },
        }

        try:
            requests.post(
                self._webhook_url(),
                json=payload,
                headers=self._headers(),
                timeout=5,
                verify=_SSL_VERIFY,
            )
            print(f"Successfully pushed {len(odds_list)} odds for card {fight_card_id} to GRIT.")
        except Exception as e:
            print(f"Error pushing batch odds: {e}")

    # ── Push: News ────────────────────────────────────────────────────────────

    def push_news_to_main_app(self, news_id: str):
        if not self.main_app_url:
            return

        res = self.supabase.table("news_articles").select("*").eq("id", news_id).single().execute()
        if not res.data:
            return

        n = res.data
        payload = {
            "sourceType": "news",
            "actionType": "create",
            "dataType": "mma_data",
            "data": {
                "title": n.get("title"),
                "excerpt": n.get("excerpt"),
                "content": n.get("content") or n.get("excerpt"),
                "layer": n.get("subtitle") or "standard",
                "publishedAt": n.get("published_at") or n.get("created_at"),
                "fighterReference": n.get("fighter_reference"),
                "eventReference": n.get("event_reference"),
            },
        }

        try:
            response = requests.post(
                self._webhook_url(),
                json=payload,
                headers=self._headers(),
                timeout=10,
                verify=_SSL_VERIFY,
            )
            response.raise_for_status()
            print(f"Successfully pushed news {news_id} to GRIT.")
        except Exception as e:
            print(f"Error pushing news to GRIT: {e}")

    # ── Discovery ─────────────────────────────────────────────────────────────

    def discover_fighter_id(self, first_name: str, last_name: str):
        try:
            url = f"{self.main_app_url}/api/fighters"
            params = {"firstName": first_name, "lastName": last_name}
            res = requests.get(url, params=params, headers=self._headers(), timeout=5, verify=_SSL_VERIFY)
            if res.status_code == 200:
                data = res.json()
                if isinstance(data, list) and len(data) > 0:
                    return data[0].get("id")
        except Exception as e:
            print(f"Discovery failed for {first_name} {last_name}: {e}")
        return None

    # ── Mapping ───────────────────────────────────────────────────────────────

    def _map_fighter_to_v2_spec(self, f: dict) -> dict:
        """
        Maps the GRIT fighters DB row to the GRIT v2.0 webhook spec.
        Reads GRIT column names (first_name, last_name, wins, losses, height_inch, etc.)
        GRIT validation rules:
          - dateOfBirth: ISO 8601 with timezone suffix (Z)
          - string fields: must be "" not null (style, fightingOutOf)
          - number fields: must be 0 not null (reach, ranking, all performance stats)
        """
        first_name = f.get("first_name", "")
        last_name = f.get("last_name", "")

        wins   = f.get("wins", 0) or 0
        losses = f.get("losses", 0) or 0
        draws  = f.get("draws", 0) or 0
        nc     = f.get("nc", 0) or 0

        raw_dob = f.get("date_of_birth")
        if raw_dob:
            dob_str = str(raw_dob)
            if "T" not in dob_str:
                dob_str = dob_str + "T00:00:00Z"
            elif not dob_str.endswith("Z") and "+" not in dob_str:
                dob_str = dob_str + "Z"
        else:
            dob_str = None

        perf = f.get("performance") or {}

        def _num(val, default=0):
            return val if isinstance(val, (int, float)) else default

        performance = {
            "ko_wins":                  _num(perf.get("ko_wins")),
            "tko_wins":                 _num(perf.get("tko_wins")),
            "submission_wins":          _num(perf.get("submission_wins")),
            "decision_wins":            _num(perf.get("decision_wins")),
            "losses_by_ko":             _num(perf.get("losses_by_ko")),
            "losses_by_submission":     _num(perf.get("losses_by_submission")),
            "losses_by_decision":       _num(perf.get("losses_by_decision")),
            "finish_rate":              _num(perf.get("finish_rate"), 0.0),
            "longest_win_streak":       _num(perf.get("longest_win_streak")),
            "strike_accuracy":          _num(perf.get("strike_accuracy"), 0.0),
            "strike_defense":           _num(perf.get("strike_defense"), 0.0),
            "takedown_avg":             _num(perf.get("takedown_avg"), 0.0),
            "takedown_accuracy":        _num(perf.get("takedown_accuracy"), 0.0),
            "takedown_defense":         _num(perf.get("takedown_defense"), 0.0),
            "submission_avg":           _num(perf.get("submission_avg"), 0.0),
            "strikes_landed_per_min":   _num(perf.get("strikes_landed_per_min"), 0.0),
            "strikes_absorbed_per_min": _num(perf.get("strikes_absorbed_per_min"), 0.0),
        }

        return {
            "firstName": first_name,
            "lastName": last_name,
            "nickname": f.get("nickname"),
            "dateOfBirth": dob_str,
            "nationality": f.get("nationality") or "Unknown",
            "gender": f.get("gender") or "Male",
            "organization": f.get("organization") or "UFC",
            "isActive": f.get("is_active", True),
            "status": f.get("status", "active"),
            "isVerified": f.get("is_verified", False),
            "isChampion": f.get("is_champion", False),
            "weightClass": f.get("weight_class") or "Unknown",
            "ranking": _num(f.get("ranking")),
            "style": f.get("style") or "",
            "headCoach": f.get("head_coach"),
            "gym": f.get("gym") or f.get("team"),
            "fightingOutOf": f.get("fighting_out_of") or "",
            "height": f.get("height_inch"),
            "reach": _num(f.get("reach_inch")),
            "wins": wins,
            "losses": losses,
            "draws": draws,
            "nc": nc,
            "needsImage": not bool(f.get("image_url")),
            "socialMedia": f.get("social_media") or {},
            "performance": performance,
            **( {"stance": f["stance"]} if f.get("stance") in ("Orthodox", "Southpaw", "Switch") else {} ),
            **( {"imageUrl": f["image_url"]} if f.get("image_url") else {} ),
            **( {"bodyImageUrl": f["body_image_url"]} if f.get("body_image_url") else {} ),
        }

    # ── Helpers ───────────────────────────────────────────────────────────────

    def link_fighters_to_events(self, fighter_id: str, fighter_name: str):
        print(f"Integrity check: Ensuring {fighter_name} links correctly to bout cards.")
