import json
from typing import Optional
from app.database.supabase_client import get_supabase
from app.database import pipeline_queue as pq
from app.scrapers.sherdog_scraper import SherdogScraper
from app.utils.search_utils import BraveSearch
from app.utils.claude_utils import get_claude, ClaudeEmptyResponseError
from app.utils.firecrawl_utils import scrape_url
from app.utils.name_utils import normalize_name, find_fighter_by_name, update_fighter_aliases
from app.prompts import PROFILE_VERIFICATION_PROMPT


def _cm_to_inch(cm) -> Optional[float]:
    if cm is None:
        return None
    try:
        return round(float(cm) / 2.54, 1)
    except Exception:
        return None


def _inch_to_cm(inches) -> Optional[float]:
    if inches is None:
        return None
    try:
        return round(float(inches) * 2.54, 1)
    except Exception:
        return None


class ProfileAgent:
    """
    Agent 2 — Profile Collector.

    Source cascade:
      1. Sherdog (BeautifulSoup)  — record, breakdown, height, gym, image, DOB
      2. Tapology (Firecrawl)     — reach, stance, nationality, fighting_out_of
      3. Claude                   — merges + normalizes both sources

    Tier validation (Tier 1 required before insert):
      Tier 1: first_name, last_name, wins, losses, weight_class
      Tier 2: height, reach, stance, nationality, gym, fighting_out_of  (fill if present)
      Tier 3: career stats, coach, style, social  (optional enrichment)

    No hardcoded "Unknown" defaults — null is stored and omitted when appropriate.
    """

    def __init__(self):
        self.supabase = get_supabase()
        self.sherdog = SherdogScraper()
        self.search_tool = BraveSearch()

    # ── URL Finders ────────────────────────────────────────────────────────────

    def _find_sherdog_url(self, fighter_name: str) -> Optional[str]:
        results = self.search_tool.search(
            f"site:sherdog.com {fighter_name} fighter", count=3
        )
        for r in results:
            url = r.get("url", "")
            if "sherdog.com/fighter/" in url:
                return url
        return None

    def _find_tapology_url(self, fighter_name: str) -> Optional[str]:
        results = self.search_tool.search(
            f"site:tapology.com fightcenter fighters {fighter_name}", count=3
        )
        for r in results:
            url = r.get("url", "")
            if "tapology.com/fightcenter/fighters/" in url:
                return url
        return None

    # ── Main Run ───────────────────────────────────────────────────────────────

    def run(self, fighter_name: str) -> str:
        pq.update_status(fighter_name, "profiling")
        print(f"\n[Agent2] ===== PROFILING: {fighter_name} =====")

        # ── STEP 1: SHERDOG ────────────────────────────────────────────────────
        sher_url = self._find_sherdog_url(fighter_name)
        sher_profile: dict = {}
        if sher_url:
            sher_profile = self.sherdog.get_fighter_profile(sher_url)
            print(
                f"[Agent2][{fighter_name}] SHERDOG: url={sher_url}\n"
                f"  wins={sher_profile.get('record_wins')} "
                f"losses={sher_profile.get('record_losses')} "
                f"wc={sher_profile.get('weight_class')!r} "
                f"gym={sher_profile.get('gym')!r} "
                f"image={'YES' if sher_profile.get('image_url') else 'NO'} "
                f"height_cm={sher_profile.get('height_cm')} "
                f"ko={sher_profile.get('ko_wins')} sub={sher_profile.get('sub_wins')} "
                f"dec={sher_profile.get('dec_wins')}"
            )
        else:
            print(f"[Agent2][{fighter_name}] SHERDOG: URL not found")

        # ── STEP 2: TAPOLOGY (Firecrawl) ──────────────────────────────────────
        tap_url = self._find_tapology_url(fighter_name)
        tap_raw: str = ""
        if tap_url:
            tap_raw = scrape_url(tap_url) or ""
            print(
                f"[Agent2][{fighter_name}] TAPOLOGY: url={tap_url} "
                f"chars={len(tap_raw)}"
            )
            if not tap_raw:
                print(f"[Agent2][{fighter_name}] TAPOLOGY: Firecrawl returned empty")
        else:
            print(f"[Agent2][{fighter_name}] TAPOLOGY: URL not found")

        # ── STEP 3: EARLY CHECK — need at least something ─────────────────────
        sher_has_record = (
            sher_profile.get("record_wins") is not None
            or sher_profile.get("record_losses") is not None
        )
        if not sher_has_record and not tap_raw:
            pq.update_status(fighter_name, "error")
            print(
                f"[Agent2][{fighter_name}] EARLY ABORT: no usable data from any source"
            )
            return f"[Agent2] No usable data for {fighter_name}. Skipping."

        # ── STEP 4: CLAUDE VERIFICATION ───────────────────────────────────────
        source_block = f"Sherdog scraped data:\n{json.dumps(sher_profile, default=str)}"
        if tap_raw:
            source_block += f"\n\nTapology page markdown (truncated):\n{tap_raw[:5000]}"

        user_content = f"Fighter name: {fighter_name}\n\n{source_block}"

        claude = get_claude()
        verified_data: dict = {}
        claude_ok = False

        for attempt in (1, 2):
            try:
                verified_data = claude.analyze(
                    PROFILE_VERIFICATION_PROMPT,
                    user_content,
                    required_keys=["record_wins", "record_losses"],
                )
                claude_ok = True
                break
            except ClaudeEmptyResponseError as e:
                print(
                    f"[Agent2][{fighter_name}] Claude attempt {attempt} failed: {e}"
                )

        if not claude_ok:
            print(
                f"[Agent2][{fighter_name}] CLAUDE: both attempts failed — "
                f"building from raw scraped data only"
            )
            verified_data = {}

        print(
            f"[Agent2][{fighter_name}] CLAUDE OUTPUT: "
            f"wins={verified_data.get('record_wins')} "
            f"losses={verified_data.get('record_losses')} "
            f"wc={verified_data.get('weight_class')!r} "
            f"nationality={verified_data.get('nationality')!r} "
            f"reach_cm={verified_data.get('reach_cm')} "
            f"stance={verified_data.get('stance')!r} "
            f"gym={verified_data.get('gym')!r}"
        )

        # ── STEP 5: MERGE (Claude wins; Sherdog fills gaps) ───────────────────
        wins = verified_data.get("record_wins") if verified_data.get("record_wins") is not None \
            else sher_profile.get("record_wins")
        losses = verified_data.get("record_losses") if verified_data.get("record_losses") is not None \
            else sher_profile.get("record_losses")
        weight_class = verified_data.get("weight_class") or sher_profile.get("weight_class")
        gym = verified_data.get("gym") or sher_profile.get("gym")
        image_url = verified_data.get("image_url") or sher_profile.get("image_url")

        # reach: Claude gets it from Tapology markdown if present
        reach_cm = verified_data.get("reach_cm")
        reach_inch = _cm_to_inch(reach_cm) if reach_cm else None

        # stance: only accept valid values
        raw_stance = verified_data.get("stance") or sher_profile.get("stance")
        stance = raw_stance if raw_stance in ("Orthodox", "Southpaw", "Switch") else None

        # ── STEP 6: TIER 1 VALIDATION ─────────────────────────────────────────
        norm_first, norm_last = normalize_name(fighter_name)
        missing = []
        if not norm_first:
            missing.append("first_name")
        if not norm_last:
            missing.append("last_name")
        if wins is None:
            missing.append("wins")
        if losses is None:
            missing.append("losses")
        if not weight_class:
            missing.append("weight_class")

        if missing:
            pq.update_status(fighter_name, "error")
            print(
                f"[Agent2][{fighter_name}] TIER1 FAIL — missing: {missing}. "
                f"NOT inserting into DB."
            )
            return f"[Agent2] Tier 1 validation failed for {fighter_name}: {missing}"

        print(f"[Agent2][{fighter_name}] TIER1 PASS")

        # ── STEP 7: BUILD PERFORMANCE JSONB ───────────────────────────────────
        ko_wins  = verified_data.get("ko_wins")  if verified_data.get("ko_wins")  is not None else sher_profile.get("ko_wins",  0)
        tko_wins = verified_data.get("tko_wins") if verified_data.get("tko_wins") is not None else 0
        sub_wins = verified_data.get("sub_wins") if verified_data.get("sub_wins") is not None else sher_profile.get("sub_wins", 0)
        dec_wins = verified_data.get("dec_wins") if verified_data.get("dec_wins") is not None else sher_profile.get("dec_wins", 0)
        total = int(wins or 0) + int(losses or 0)
        finish_rate = round((int(ko_wins or 0) + int(tko_wins or 0) + int(sub_wins or 0)) / total, 3) if total > 0 else None

        performance = {
            "ko_wins":                  int(ko_wins or 0),
            "tko_wins":                 int(tko_wins or 0),
            "submission_wins":          int(sub_wins or 0),
            "decision_wins":            int(dec_wins or 0),
            "finish_rate":              finish_rate,
            "losses_by_ko":             int(verified_data.get("losses_by_ko") or sher_profile.get("losses_by_ko") or 0),
            "losses_by_submission":     int(verified_data.get("losses_by_submission") or sher_profile.get("losses_by_submission") or 0),
            "losses_by_decision":       int(verified_data.get("losses_by_decision") or sher_profile.get("losses_by_decision") or 0),
            "strike_accuracy":          verified_data.get("strike_accuracy"),
            "strike_defense":           verified_data.get("strike_defense"),
            "takedown_avg":             verified_data.get("takedown_avg"),
            "takedown_accuracy":        verified_data.get("takedown_accuracy"),
            "takedown_defense":         verified_data.get("takedown_defense"),
            "strikes_landed_per_min":   verified_data.get("slpm"),
            "strikes_absorbed_per_min": verified_data.get("sapm"),
            "submission_avg":           verified_data.get("submission_avg"),
            "longest_win_streak":       verified_data.get("longest_win_streak") or 0,
        }

        # ── STEP 8: BUILD SOCIAL JSONB ────────────────────────────────────────
        social_media = {
            "twitter":   verified_data.get("twitter_handle"),
            "instagram": verified_data.get("instagram_handle"),
            "website":   verified_data.get("website_url"),
        }

        # ── STEP 9: BUILD UPSERT PAYLOAD — no "Unknown" defaults ─────────────
        upsert = {
            "first_name":      norm_first,
            "last_name":       norm_last,
            "nickname":        verified_data.get("nickname") or sher_profile.get("nickname") or None,
            "gender":          verified_data.get("gender") or "Male",
            "nationality":     verified_data.get("nationality"),
            "date_of_birth":   verified_data.get("dob") or sher_profile.get("dob"),
            "organization":    verified_data.get("organization") or "UFC",
            "weight_class":    weight_class,
            "height_inch":     _cm_to_inch(verified_data.get("height_cm") or sher_profile.get("height_cm")),
            "reach_inch":      reach_inch,
            "leg_reach_inch":  _cm_to_inch(verified_data.get("leg_reach_cm")),
            "stance":          stance,
            "is_active":       verified_data.get("is_active") if verified_data.get("is_active") is not None else True,
            "is_champion":     verified_data.get("isChampion") or False,
            "ranking":         verified_data.get("ranking"),
            "style":           verified_data.get("style"),
            "gym":             gym,
            "team":            gym,
            "head_coach":      verified_data.get("headCoach"),
            "fighting_out_of": verified_data.get("fighting_out_of"),
            "wins":            int(wins),
            "losses":          int(losses),
            "draws":           int(verified_data.get("record_draws") or sher_profile.get("record_draws") or 0),
            "nc":              int(verified_data.get("record_nc") or sher_profile.get("record_nc") or 0),
            "image_url":       image_url,
            "social_media":    social_media,
            "performance":     performance,
            "notes":           verified_data.get("review_notes"),
            "is_verified":     True,
        }

        # ── STEP 10: STRIP NULLS FOR FIELDS WITH NOT NULL DB CONSTRAINTS ─────
        # These columns are NOT NULL in the schema — never pass null.
        # All other optional fields pass null on UPDATE to clear stale defaults.
        DB_NOT_NULL = {
            "nationality",  # confirmed NOT NULL in fighters table
            "stance",       # confirmed NOT NULL in fighters table
        }
        # INSERT: also strip truly optional nullable fields to keep payload clean
        INSERT_ALSO_STRIP = {
            "leg_reach_inch", "ranking", "style",
            "fighting_out_of", "notes", "date_of_birth", "team",
            "reach_inch", "nickname", "head_coach", "image_url",
        }
        insert_strip = DB_NOT_NULL | INSERT_ALSO_STRIP
        insert_payload = {
            k: v for k, v in upsert.items()
            if v is not None or k not in insert_strip
        }

        # ── STEP 11: DEDUP → INSERT OR UPDATE ─────────────────────────────────
        existing = find_fighter_by_name(self.supabase, norm_first, norm_last)
        if existing:
            fighter_id = existing["id"]
            update_fighter_aliases(self.supabase, fighter_id, fighter_name)
            # For UPDATE: pass nulls for optional fields (clears stale "Unknown")
            # but skip DB_NOT_NULL fields if they're null to avoid constraint errors.
            update_payload = {
                k: v for k, v in upsert.items()
                if k != "aliases" and (v is not None or k not in DB_NOT_NULL)
            }
            self.supabase.table("fighters").update(update_payload).eq("id", fighter_id).execute()
            print(
                f"[Agent2][{fighter_name}] UPDATED existing record "
                f"(ID: {fighter_id})"
            )
        else:
            res = self.supabase.table("fighters").insert(insert_payload).execute()
            fighter_id = res.data[0]["id"]
            print(
                f"[Agent2][{fighter_name}] INSERTED new record "
                f"(ID: {fighter_id})"
            )

        pq.update_status(fighter_name, "profiling", fighter_id=fighter_id)
        
        # ── STEP 12: TRIGGER EVENT FIGHT RECONCILIATION ───────────────────────
        # After successfully profiling a fighter, check if this completes any event_fights
        try:
            from app.services.event_fight_reconciler import EventFightReconciler
            reconciler = EventFightReconciler()
            
            # Get the event_id from the queue job
            job = pq.get_job(fighter_name)
            event_id = job.get("event_id")
            
            if event_id:
                print(f"[Agent2][{fighter_name}] Triggering event fight reconciliation for event {event_id}")
                result = reconciler.reconcile_event(event_id)
                created = result.get("created_fights", 0)
                if created > 0:
                    print(f"[Agent2][{fighter_name}] Created {created} missing event_fight records")
        except Exception as e:
            print(f"[Agent2][{fighter_name}] Reconciliation trigger failed: {e}")
            # Non-critical - don't fail the profile if reconciliation fails
        
        return f"Profile recorded for {fighter_name}. ID: {fighter_id}"
