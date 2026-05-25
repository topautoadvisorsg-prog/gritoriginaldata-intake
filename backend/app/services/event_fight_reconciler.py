"""
Event Fight Reconciliation Service

Ensures event_fights table is complete by backfilling missing bout pairings
after fighters are added to the database.

This service runs:
1. After Agent 2 (ProfileAgent) completes for a fighter
2. As a scheduled reconciliation job (periodic integrity check)
3. Manually via API endpoint for operator-triggered repair
"""

import os
from typing import List, Dict, Tuple, Optional
from app.database.supabase_client import get_supabase
from app.utils.name_utils import normalize_name


def _find_fighter_exact_match(supabase, first_name: str, last_name: str):
    """
    Find fighter by EXACT normalized name match only.
    No fuzzy logic. No alias matching. No guessing.
    
    Either finds the fighter or returns None — manual fix required if missing.
    """
    norm_first, norm_last = normalize_name(f"{first_name} {last_name}")
    
    try:
        res = supabase.table("fighters").select("id, first_name, last_name").ilike(
            "first_name", norm_first
        ).ilike("last_name", norm_last).execute()
        
        if res.data and len(res.data) > 0:
            return res.data[0]
        return None
    except Exception:
        return None


class EventFightReconciler:
    """
    Reconciles missing event_fights records by:
    1. Loading stored bout information from events
    2. Checking if both fighters now exist in DB
    3. Creating missing event_fights records
    """
    
    def __init__(self):
        self.supabase = get_supabase()
    
    def reconcile_event(self, event_id: str) -> Dict:
        """
        Reconcile a single event's fight pairings.
        
        Returns dict with:
        - expected_fights: int (total bouts on card)
        - existing_fights: int (currently in event_fights table)
        - created_fights: int (newly created in this run)
        - missing_fights: int (still missing due to fighters not in DB)
        - status: "complete" | "incomplete"
        """
        # Get event details
        event_res = self.supabase.table("events").select("*").eq("id", event_id).single().execute()
        if not event_res.data:
            return {"error": f"Event {event_id} not found"}
        
        event = event_res.data
        
        # Get all queued fighters for this event (from pipeline queue file)
        # This gives us the original scraped bout information
        from app.database import pipeline_queue as pq
        all_jobs = pq.get_all()
        event_jobs = [j for j in all_jobs if j.get("event_id") == event_id]
        
        # Extract unique fighter names from queue
        queued_fighter_names = list({j["fighter_name"] for j in event_jobs})
        
        # Also check existing event_fights to get fighters already recorded
        existing_fights_res = self.supabase.table("event_fights").select(
            "fighter1_id, fighter2_id"
        ).eq("event_id", event_id).execute()
        
        existing_fighter_ids = set()
        for fight in (existing_fights_res.data or []):
            existing_fighter_ids.add(fight["fighter1_id"])
            existing_fighter_ids.add(fight["fighter2_id"])
        
        # Build complete fighter roster for this event
        all_fighter_ids = set(existing_fighter_ids)
        
        # Try to resolve queued fighter names to IDs
        for fighter_name in queued_fighter_names:
            first, last = normalize_name(fighter_name)
            fighter_rec = _find_fighter_exact_match(self.supabase, first, last)
            if fighter_rec:
                all_fighter_ids.add(fighter_rec["id"])
        
        # Now we need to reconstruct the bout pairings
        # Since we don't store the original pairings separately, we'll use a heuristic:
        # Look at pipeline queue entries and try to infer pairings from timing/event association
        
        # Better approach: Re-scrape the event to get current bout list
        # For now, we'll work with what we have in event_fights + try to add missing ones
        
        result = {
            "event_id": event_id,
            "event_name": event.get("name"),
            "expected_fights": 0,  # Will be updated when we scrape
            "existing_fights": len(existing_fights_res.data or []),
            "created_fights": 0,
            "missing_fights": 0,
            "status": "incomplete",
            "details": [],
        }
        
        # Try to re-scrape event to get accurate bout list
        try:
            from app.scrapers.ufcstats_scraper import UFCStatsScraper
            from app.utils.search_utils import BraveSearch
            
            scraper = UFCStatsScraper()
            search_tool = BraveSearch()
            
            # Find event URL
            event_url = None
            if event.get("name"):
                # Try UFCStats internal search first
                event_url = scraper.find_event_url(event["name"])
                
                # Fallback to Brave Search
                if not event_url:
                    results = search_tool.search(f"site:ufcstats.com {event['name']}", count=3)
                    for r in results:
                        if "ufcstats.com/event-details/" in r.get("url", ""):
                            event_url = r["url"]
                            break
            
            if event_url:
                # Scrape current fight card
                card_data = scraper.get_fight_card(event_url)
                bouts = card_data.get("bouts", [])
                result["expected_fights"] = len(bouts)
                
                # Try to create missing event_fights
                for card_pos, bout in enumerate(bouts, start=1):
                    fa_name = bout.get("fighter_a", "")
                    fb_name = bout.get("fighter_b", "")
                    
                    if not fa_name or not fb_name:
                        continue
                    
                    # Normalize names
                    fa_first, fa_last = normalize_name(fa_name)
                    fb_first, fb_last = normalize_name(fb_name)
                    
                    # Find fighters in DB (EXACT MATCH ONLY)
                    fa_rec = _find_fighter_exact_match(self.supabase, fa_first, fa_last)
                    fb_rec = _find_fighter_exact_match(self.supabase, fb_first, fb_last)
                    
                    if fa_rec and fb_rec:
                        # Check if bout already exists
                        existing = self.supabase.table("event_fights").select("id").eq(
                            "event_id", event_id
                        ).eq("fighter1_id", fa_rec["id"]).eq(
                            "fighter2_id", fb_rec["id"]
                        ).execute()
                        
                        if not existing.data:
                            # Create missing event_fights record
                            self.supabase.table("event_fights").insert({
                                "event_id": event_id,
                                "fighter1_id": fa_rec["id"],
                                "fighter2_id": fb_rec["id"],
                                "weight_class": bout.get("weight_class"),
                                "card_placement": card_pos,
                                "bout_order": card_pos,
                                "status": "scheduled",
                            }).execute()
                            
                            result["created_fights"] += 1
                            result["details"].append({
                                "action": "created",
                                "bout": f"{fa_name} vs {fb_name}",
                                "card_position": card_pos,
                            })
                        else:
                            result["details"].append({
                                "action": "exists",
                                "bout": f"{fa_name} vs {fb_name}",
                            })
                    else:
                        # One or both fighters not in DB yet
                        result["missing_fights"] += 1
                        result["details"].append({
                            "action": "missing_fighters",
                            "bout": f"{fa_name} vs {fb_name}",
                            "fighter_a_in_db": fa_rec is not None,
                            "fighter_b_in_db": fb_rec is not None,
                        })
            else:
                # Cannot scrape - event URL not found
                result["details"].append({
                    "warning": "Could not find event URL for re-scraping",
                    "event_name": event.get("name"),
                })
                
        except Exception as e:
            result["details"].append({
                "error": f"Reconciliation failed: {str(e)}",
            })
        
        # Determine final status
        if result["expected_fights"] > 0:
            if result["existing_fights"] + result["created_fights"] == result["expected_fights"]:
                result["status"] = "complete"
            else:
                result["status"] = "incomplete"
        else:
            # No expected count available - judge by what we have
            if result["existing_fights"] + result["created_fights"] > 0:
                result["status"] = "partial"
            else:
                result["status"] = "unknown"
        
        # Log activity
        self._log_activity(event_id, event.get("name", ""), result)
        
        return result
    
    def reconcile_all_upcoming_events(self) -> List[Dict]:
        """
        Reconcile all upcoming events.
        Returns list of reconciliation results.
        """
        events_res = self.supabase.table("events").select("id, name").eq(
            "status", "Upcoming"
        ).execute()
        
        results = []
        for event in (events_res.data or []):
            result = self.reconcile_event(event["id"])
            results.append(result)
        
        return results
    
    def get_event_completeness(self, event_id: str) -> Dict:
        """
        Get completeness status for an event without modifying data.
        
        Returns:
        {
            "event_id": str,
            "event_name": str,
            "expected_fights": int (from scrape),
            "actual_fights": int (from event_fights table),
            "is_complete": bool,
            "missing_bouts": [...],
            "fighters_in_db": [...],
            "fighters_pending": [...],
        }
        """
        event_res = self.supabase.table("events").select("*").eq("id", event_id).single().execute()
        if not event_res.data:
            return {"error": f"Event {event_id} not found"}
        
        event = event_res.data
        
        # Get existing fights
        fights_res = self.supabase.table("event_fights").select(
            "id, fighter1_id, fighter2_id, weight_class, card_placement"
        ).eq("event_id", event_id).order("card_placement").execute()
        
        existing_fights = fights_res.data or []
        
        # Try to scrape expected fights
        expected_fights = 0
        missing_bouts = []
        
        try:
            from app.scrapers.ufcstats_scraper import UFCStatsScraper
            from app.utils.search_utils import BraveSearch
            
            scraper = UFCStatsScraper()
            search_tool = BraveSearch()
            
            event_url = scraper.find_event_url(event["name"])
            if not event_url:
                results = search_tool.search(f"site:ufcstats.com {event['name']}", count=3)
                for r in results:
                    if "ufcstats.com/event-details/" in r.get("url", ""):
                        event_url = r["url"]
                        break
            
            if event_url:
                card_data = scraper.get_fight_card(event_url)
                expected_fights = len(card_data.get("bouts", []))
                
                # Check each expected bout
                for card_pos, bout in enumerate(card_data.get("bouts", []), start=1):
                    fa_name = bout.get("fighter_a", "")
                    fb_name = bout.get("fighter_b", "")
                    
                    if not fa_name or not fb_name:
                        continue
                    
                    fa_first, fa_last = normalize_name(fa_name)
                    fb_first, fb_last = normalize_name(fb_name)
                    
                    fa_rec = _find_fighter_exact_match(self.supabase, fa_first, fa_last)
                    fb_rec = _find_fighter_exact_match(self.supabase, fb_first, fb_last)
                    
                    # Check if this bout exists in event_fights
                    bout_exists = any(
                        (f["fighter1_id"] == (fa_rec["id"] if fa_rec else None) and
                         f["fighter2_id"] == (fb_rec["id"] if fb_rec else None))
                        for f in existing_fights
                    )
                    
                    if not bout_exists:
                        missing_bouts.append({
                            "card_position": card_pos,
                            "fighter_a": fa_name,
                            "fighter_b": fb_name,
                            "weight_class": bout.get("weight_class"),
                            "fighter_a_in_db": fa_rec is not None,
                            "fighter_b_in_db": fb_rec is not None,
                        })
        except Exception as e:
            pass  # Will work with what we have
        
        # Collect fighter status
        fighters_in_db = []
        fighters_pending = []
        
        from app.database import pipeline_queue as pq
        all_jobs = pq.get_all()
        event_jobs = [j for j in all_jobs if j.get("event_id") == event_id]
        
        for job in event_jobs:
            fighter_name = job["fighter_name"]
            if job.get("fighter_id"):
                fighters_in_db.append(fighter_name)
            else:
                fighters_pending.append(fighter_name)
        
        is_complete = (len(missing_bouts) == 0 and expected_fights > 0)
        
        return {
            "event_id": event_id,
            "event_name": event.get("name"),
            "expected_fights": expected_fights,
            "actual_fights": len(existing_fights),
            "is_complete": is_complete,
            "missing_bouts": missing_bouts,
            "fighters_in_db": fighters_in_db,
            "fighters_pending": fighters_pending,
        }
    
    def _log_activity(self, event_id: str, event_name: str, result: Dict):
        """Log reconciliation activity to activity_log table."""
        try:
            detail_msg = (
                f"Reconciliation: {result.get('created_fights', 0)} fights created, "
                f"{result.get('missing_fights', 0)} still missing. "
                f"Status: {result.get('status', 'unknown')}"
            )
            
            self.supabase.table("activity_log").insert({
                "agent_name": "Reconciler",
                "action": "reconciled",
                "entity_type": "event",
                "entity_id": event_id,
                "entity_name": event_name,
                "status": result.get("status", "unknown"),
                "detail": detail_msg,
            }).execute()
        except Exception as e:
            print(f"[Reconciler] Failed to log activity: {e}")


# Convenience functions for API endpoints
def reconcile_event_endpoint(event_id: str) -> Dict:
    """API endpoint handler for reconciling a single event."""
    reconciler = EventFightReconciler()
    return reconciler.reconcile_event(event_id)


def reconcile_all_events_endpoint() -> List[Dict]:
    """API endpoint handler for reconciling all upcoming events."""
    reconciler = EventFightReconciler()
    return reconciler.reconcile_all_upcoming_events()


def get_event_completeness_endpoint(event_id: str) -> Dict:
    """API endpoint handler for checking event completeness."""
    reconciler = EventFightReconciler()
    return reconciler.get_event_completeness(event_id)
