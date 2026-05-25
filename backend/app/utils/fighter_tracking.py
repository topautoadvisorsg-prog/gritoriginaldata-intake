"""
Fighter tracking state — persists per-fighter scan timestamps.

Stored in backend/.fighter_tracking.json (same pattern as .pipeline_queue.json).
Keys are fighter UUIDs. Values:
  {
    "fighter_id": "...",
    "fighter_name": "...",
    "event_id": "...",
    "event_name": "...",
    "last_full_scan_at": "2026-03-25T...",
    "last_incremental_scan_at": "2026-03-25T..."
  }
"""
import os
import json
from datetime import datetime, timezone
from typing import Optional

_TRACKING_FILE = os.path.join(os.path.dirname(__file__), "..", "..", ".fighter_tracking.json")


def _load() -> dict:
    path = os.path.abspath(_TRACKING_FILE)
    if not os.path.exists(path):
        return {}
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return {}


def _save(data: dict):
    path = os.path.abspath(_TRACKING_FILE)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)


def get_tracking(fighter_id: str) -> Optional[dict]:
    """Return tracking record for a fighter, or None if never scanned."""
    return _load().get(fighter_id)


def needs_full_scan(fighter_id: str) -> bool:
    """True if fighter has never had a full scan."""
    record = get_tracking(fighter_id)
    return record is None or not record.get("last_full_scan_at")


def mark_scanned(fighter_id: str, fighter_name: str, event_id: str, event_name: str, scan_type: str):
    """
    Update tracking after a scan.
    scan_type: "full" | "incremental"
    """
    data = _load()
    now = datetime.now(timezone.utc).isoformat()
    existing = data.get(fighter_id, {
        "fighter_id":   fighter_id,
        "fighter_name": fighter_name,
        "event_id":     event_id,
        "event_name":   event_name,
    })
    if scan_type == "full":
        existing["last_full_scan_at"] = now
    existing["last_incremental_scan_at"] = now
    existing["event_id"] = event_id
    existing["event_name"] = event_name
    data[fighter_id] = existing
    _save(data)


def freshness_for_fighter(fighter_id: str) -> str:
    """
    Return Brave freshness param based on how long since last incremental scan.
    Brave supports: pd (1 day), pw (1 week), pm (1 month), py (1 year).
    """
    record = get_tracking(fighter_id)
    if not record or not record.get("last_incremental_scan_at"):
        return "pm"  # first scan — go back a month

    last = datetime.fromisoformat(record["last_incremental_scan_at"])
    if last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    hours_ago = (datetime.now(timezone.utc) - last).total_seconds() / 3600

    if hours_ago <= 26:
        return "pd"
    if hours_ago <= 170:  # ~1 week
        return "pw"
    if hours_ago <= 750:  # ~1 month
        return "pm"
    return "py"


def get_all_tracked() -> list[dict]:
    """Return all tracking records as a list."""
    return list(_load().values())


def clear_event(event_id: str):
    """Remove all tracking records for a specific event (after event is over)."""
    data = _load()
    updated = {fid: r for fid, r in data.items() if r.get("event_id") != event_id}
    _save(updated)
