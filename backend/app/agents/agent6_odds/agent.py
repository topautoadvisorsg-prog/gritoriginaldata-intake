import os
import requests
from app.database.supabase_client import get_supabase
from .scraper import BestFightOddsScraper, OddsSharkScraper
import logging

logger = logging.getLogger(__name__)


class OddsAgent:
    def __init__(self):
        self.supabase = get_supabase()
        self.best_fight_odds = BestFightOddsScraper()
        self.oddsshark = OddsSharkScraper()
        self.main_app_url = os.getenv("MAIN_APP_API_URL")

    def run(self):
        logger.info("Starting Agent 6: Odds Agent pull...")
        cards = self.fetch_active_cards()
        if not cards:
            logger.info("No active cards found to pull odds for.")
            return

        for card in cards:
            card_id = card.get("id")
            bouts = card.get("bouts", [])
            for bout in bouts:
                self.process_bout(card_id, bout)

    def fetch_active_cards(self) -> list:
        if not self.main_app_url:
            logger.warning("MAIN_APP_API_URL not set. Falling back to local events.")
            try:
                res = (
                    self.supabase.table("events")
                    .select("*, event_fights(*)")
                    .eq("status", "Upcoming")
                    .execute()
                )
                return res.data or []
            except Exception as e:
                logger.error(f"Error querying local events: {e}")
                return []

        try:
            endpoint = f"{self.main_app_url.rstrip('/')}/api/events/active"
            response = requests.get(endpoint, timeout=10)
            response.raise_for_status()
            return response.json()
        except Exception as e:
            logger.error(f"Error fetching active cards from main app: {e}")
            try:
                res = (
                    self.supabase.table("events")
                    .select("*, event_fights(*)")
                    .eq("status", "Upcoming")
                    .execute()
                )
                return res.data or []
            except Exception as e2:
                logger.error(f"Local events fallback also failed: {e2}")
                return []

    def process_bout(self, fight_card_id: str, bout: dict):
        # Support both main-app format {fighter_a: {name: ...}} and
        # local GRIT Supabase format {fighter1_id: uuid, fighter2_id: uuid}
        fighter_a = (bout.get("fighter_a") or {}).get("name")
        fighter_b = (bout.get("fighter_b") or {}).get("name")

        if not fighter_a and bout.get("fighter1_id"):
            try:
                res = self.supabase.table("fighters").select("first_name, last_name").eq("id", bout["fighter1_id"]).single().execute()
                if res.data:
                    fighter_a = f"{res.data['first_name']} {res.data['last_name']}".strip()
            except Exception:
                pass

        if not fighter_b and bout.get("fighter2_id"):
            try:
                res = self.supabase.table("fighters").select("first_name, last_name").eq("id", bout["fighter2_id"]).single().execute()
                if res.data:
                    fighter_b = f"{res.data['first_name']} {res.data['last_name']}".strip()
            except Exception:
                pass

        if not fighter_a or not fighter_b:
            return

        logger.info(f"Pulling odds for {fighter_a} vs {fighter_b}")

        # Primary: BestFightOdds. Fallback: OddsShark.
        odds_data = self.best_fight_odds.get_odds(fighter_a, fighter_b)

        if not odds_data:
            logger.info(
                "BestFightOdds returned nothing — trying OddsShark fallback..."
            )
            odds_data = self.oddsshark.get_odds(fighter_a, fighter_b)

        if odds_data:
            self.store_odds(fight_card_id, odds_data)
        else:
            logger.warning(
                f"No odds found for {fighter_a} vs {fighter_b} from any source."
            )

    def store_odds(self, fight_card_id: str, odds: dict):
        try:
            source = odds.get("source")
            data = {
                "fight_card_id": fight_card_id,
                "fighter1_ml": odds.get("fighter_a_line"),
                "fighter2_ml": odds.get("fighter_b_line"),
                "over_under": odds.get("over_under"),
                "method_ko_tko": odds.get("method_ko_tko"),
                "method_submission": odds.get("method_submission"),
                "method_decision": odds.get("method_decision"),
                "source": source,
                "status": "staging",
            }

            # Check for an existing row for this (fight_card_id, source) pair.
            # Re-running Agent 6 should update the odds rather than create duplicates.
            existing = (
                self.supabase.table("odds")
                .select("id")
                .eq("fight_card_id", fight_card_id)
                .eq("source", source)
                .limit(1)
                .execute()
            )
            if existing.data:
                row_id = existing.data[0]["id"]
                self.supabase.table("odds").update(data).eq("id", row_id).execute()
                logger.info(
                    f"Updated existing odds row {row_id} for fight_card_id={fight_card_id} source={source}."
                )
            else:
                self.supabase.table("odds").insert(data).execute()
                logger.info(
                    f"Inserted new odds for fight_card_id={fight_card_id} source={source} as staging."
                )
        except Exception as e:
            logger.error(f"Error storing odds: {e}")
