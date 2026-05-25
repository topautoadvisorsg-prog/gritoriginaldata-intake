import os
import json
from app.database.supabase_client import get_supabase
from app.database import pipeline_queue as pq
from app.utils.search_utils import BraveSearch
from app.utils.name_utils import normalize_name, find_fighter_by_name, update_fighter_aliases
from app.scrapers.ufcstats_scraper import UFCStatsScraper


class EventAgent:
    """
    Agent 1 — Event Scanner.

    Scans UFCStats for a given event, records the event and bouts,
    and queues new fighters for profiling.

    No CrewAI dependency — runs as plain Python.
    """

    def __init__(self):
        self.supabase = get_supabase()
        self.search_tool = BraveSearch()
        self.scraper = UFCStatsScraper()

    def run(self, event_name: str, event_url: str = "") -> str:
        """
        Scan UFCStats for a given event, extract the fight card,
        check for existing fighters, record the event/bouts, and queue new fighters.

        Pass event_url (from UFCStats upcoming events list) to skip the URL-search step.
        If event_url is empty, falls back to UFCStats internal search then Brave Search.

        Data source: http://ufcstats.com (publicly accessible, no Cloudflare blocking).
        Tapology is Cloudflare-protected and cannot be scraped with direct HTTP requests.
        """
        # 1. Use the pre-scraped URL if provided (avoids redundant URL search).
        if not event_url:
            # 2. Fallback: UFCStats internal search
            event_url = self.scraper.find_event_url(event_name)

        # 3. Fallback: Brave Search targeting ufcstats.com
        if not event_url:
            results = self.search_tool.search(f"site:ufcstats.com {event_name}", count=5)
            for r in results:
                url = r.get("url", "")
                if "ufcstats.com/event-details/" in url:
                    event_url = url
                    break

        if not event_url:
            return (
                f"Error: Could not find UFCStats event URL for '{event_name}'. "
                "Make sure the event name matches UFCStats naming (e.g. 'UFC 309')."
            )

        # 4. Scrape fight card
        data = self.scraper.get_fight_card(event_url)
        if not data["fighters"]:
            return (
                f"Error: Could not extract fighters from {event_url}. "
                "The event page may not have bouts listed yet."
            )

        # 5. Upsert event record using GRIT events schema
        meta = data["metadata"]
        location_raw = meta.get("location", "")
        location_parts = [p.strip() for p in location_raw.split(",")]

        # Parse location: UFCStats format is either
        #  "Venue, City, State, Country" (4 parts)  or
        #  "City, State, Country"        (3 parts)  or
        #  "City, Country"               (2 parts)
        venue = "TBD"
        city = state = country = ""
        if len(location_parts) >= 4:
            venue   = location_parts[0]
            city    = location_parts[1]
            state   = location_parts[2]
            country = location_parts[3]
        elif len(location_parts) == 3:
            venue   = location_parts[0]
            city    = location_parts[0]
            state   = location_parts[1]
            country = location_parts[2]
        elif len(location_parts) == 2:
            city    = location_parts[0]
            country = location_parts[1]

        if meta.get("venue"):
            venue = meta["venue"]

        event_payload = {
            "name": meta.get("event_name") or event_name,
            "date": meta.get("date"),
            "status": meta.get("status", "Upcoming"),
            "organization": "UFC",
            "venue": venue,
        }
        if city:    event_payload["city"]    = city
        if state:   event_payload["state"]   = state
        if country: event_payload["country"] = country

        existing_event = self.supabase.table("events").select("id").eq("name", event_payload["name"]).execute()
        if not existing_event.data:
            event_res = self.supabase.table("events").insert(event_payload).execute()
        else:
            self.supabase.table("events").update(event_payload).eq("id", existing_event.data[0]["id"]).execute()
            event_res = self.supabase.table("events").select("id, name, date").eq("name", event_payload["name"]).execute()

        event_id = event_res.data[0]["id"]
        event_date = event_res.data[0].get("date") or meta.get("date") or ""

        # 6. Queue new fighters using file-based queue.
        # normalize_name() handles Unicode and case differences for reliable dedup.
        # Three-stage lookup: exact → alias containment → fuzzy at 0.75.
        new_fighters = []
        for fighter_name in data["fighters"]:
            f_first, f_last = normalize_name(fighter_name)
            existing = find_fighter_by_name(self.supabase, f_first, f_last)
            if existing:
                update_fighter_aliases(self.supabase, existing["id"], fighter_name)
                print(f"[Agent1] Fighter '{fighter_name}' already exists in DB (ID: {existing['id']}). Skipping queue.")
                continue

            added = pq.add_fighter(
                fighter_name=fighter_name,
                event_id=event_id,
                event_name=event_payload["name"],
                event_date=str(event_date) if event_date else "",
            )
            if added:
                new_fighters.append(fighter_name)
            else:
                print(f"Fighter {fighter_name} already in pipeline queue. Skipping.")

        # 7. Record bouts in event_fights table using GRIT schema
        for card_pos, bout in enumerate(data["bouts"], start=1):
            try:
                fa_name = bout.get("fighter_a", "")
                fb_name = bout.get("fighter_b", "")

                if fa_name and fb_name:
                    fa_first, fa_last = normalize_name(fa_name)
                    fb_first, fb_last = normalize_name(fb_name)

                    fa_rec = find_fighter_by_name(self.supabase, fa_first, fa_last)
                    fb_rec = find_fighter_by_name(self.supabase, fb_first, fb_last)
                    if fa_rec and fb_rec:
                        # Check if this bout already exists to avoid duplicates
                        existing_bout = self.supabase.table("event_fights").select("id").eq(
                            "event_id", event_id
                        ).eq("fighter1_id", fa_rec["id"]).eq("fighter2_id", fb_rec["id"]).execute()
                        if existing_bout.data:
                            print(f"[Agent1] Bout {fa_name} vs {fb_name} already recorded. Skipping.")
                            continue
                        self.supabase.table("event_fights").insert({
                            "event_id": event_id,
                            "fighter1_id": fa_rec["id"],
                            "fighter2_id": fb_rec["id"],
                            "weight_class": bout.get("weight_class"),
                            "card_placement": card_pos,
                            "bout_order": card_pos,
                            "status": "scheduled",
                        }).execute()
                        print(f"[Agent1] Recorded bout #{card_pos}: {fa_name} vs {fb_name}")
            except Exception as e:
                print(f"[Agent1] Could not record bout {bout}: {e}")

        return (
            f"Successfully scanned '{event_name}' from UFCStats. "
            f"Found {len(data['fighters'])} fighters, {len(data['bouts'])} bouts. "
            f"{len(new_fighters)} new fighters queued for profiling."
        )
