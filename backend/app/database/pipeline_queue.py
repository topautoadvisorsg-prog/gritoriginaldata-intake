"""
File-based pipeline queue manager.

Each job entry shape:
  {
    "fighter_name":      str,
    "status":            "queued" | "profiling" | "history" | "imaging" | "complete" | "failed",
    "event_id":          str,
    "event_name":        str,
    "event_date":        str,
    "fighter_id":        str | None,
    "attempt_count":     int,          # incremented on every retry
    "last_error":        str | None,   # last captured exception message
    "queued_at":         str,          # ISO-8601 timestamp when first added
    "status_updated_at": str,          # ISO-8601 timestamp of last status change
  }

Terminal states:  "complete", "failed"
Non-terminal:     "queued", "profiling", "history", "imaging"
"""
import json
import os
import threading
from datetime import datetime, timezone, timedelta

QUEUE_FILE = os.path.join(os.path.dirname(__file__), "../../.pipeline_queue.json")
_lock = threading.Lock()

_TERMINAL_STATES = {"complete", "failed"}
# States that represent active processing work. "queued" is intentionally excluded:
# a job waiting in the queue for >30 min is normal (operator hasn't triggered the
# queue yet). Only jobs actually being processed by an agent should time out.
_ACTIVE_PROCESSING_STATES = {"profiling", "history", "intelligence", "imaging"}
_MAX_ATTEMPTS = 3
_STUCK_TIMEOUT_MINUTES = 30


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _read() -> list:
    if not os.path.exists(QUEUE_FILE):
        return []
    with open(QUEUE_FILE, "r") as f:
        try:
            return json.load(f)
        except Exception:
            return []


def _write(queue: list):
    with open(QUEUE_FILE, "w") as f:
        json.dump(queue, f, indent=2)


_EPOCH_SENTINEL = "1970-01-01T00:00:00+00:00"


def _backfill_job(j: dict) -> dict:
    """Ensure legacy queue entries have the new fields so code never KeyErrors.

    status_updated_at intentionally defaults to the epoch sentinel (not "now")
    so that legacy stuck jobs are treated as immediately stale by check_stuck_jobs.
    Any epoch timestamp will always be older than the 30-minute cutoff, causing the
    timeout logic to fire on the very first scheduler tick after upgrade.
    """
    j.setdefault("attempt_count", 0)
    j.setdefault("last_error", None)
    j.setdefault("queued_at", _now_iso())
    j.setdefault("status_updated_at", _EPOCH_SENTINEL)
    return j


def add_fighter(fighter_name: str, event_id: str, event_name: str = "", event_date: str = "") -> bool:
    with _lock:
        queue = _read()
        if any(j["fighter_name"] == fighter_name for j in queue):
            return False
        now = _now_iso()
        queue.append({
            "fighter_name": fighter_name,
            "status": "queued",
            "event_id": event_id,
            "event_name": event_name,
            "event_date": event_date,
            "fighter_id": None,
            "attempt_count": 0,
            "last_error": None,
            "queued_at": now,
            "status_updated_at": now,
        })
        _write(queue)
        return True


def fighter_exists(fighter_name: str) -> bool:
    return any(j["fighter_name"] == fighter_name for j in _read())


def get_queued() -> list:
    return [_backfill_job(j) for j in _read() if j["status"] == "queued"]


def update_status(fighter_name: str, status: str, fighter_id: str = None):
    with _lock:
        queue = _read()
        for j in queue:
            if j["fighter_name"] == fighter_name:
                _backfill_job(j)
                j["status"] = status
                j["status_updated_at"] = _now_iso()
                if fighter_id is not None:
                    j["fighter_id"] = fighter_id
                break
        _write(queue)


def fail_job(fighter_name: str, error: str, max_attempts: int = _MAX_ATTEMPTS):
    """
    Record an error against a job and decide whether to retry or mark as failed.

    If attempt_count < max_attempts: resets status to "queued" so the scheduler
    will pick it up on the next tick.
    If attempt_count >= max_attempts: sets status to "failed" — the job appears
    red in the Monitor with the last error message visible.

    Always increments attempt_count and writes the error message.
    """
    with _lock:
        queue = _read()
        for j in queue:
            if j["fighter_name"] == fighter_name:
                _backfill_job(j)
                j["attempt_count"] = j["attempt_count"] + 1
                j["last_error"] = str(error)[:2000]
                j["status_updated_at"] = _now_iso()
                if j["attempt_count"] >= max_attempts:
                    j["status"] = "failed"
                    print(
                        f"[Queue] {fighter_name} FAILED after {j['attempt_count']} attempts. "
                        f"Last error: {error}"
                    )
                else:
                    j["status"] = "queued"
                    print(
                        f"[Queue] {fighter_name} errored (attempt {j['attempt_count']}/{max_attempts}). "
                        f"Re-queued for retry. Error: {error}"
                    )
                break
        _write(queue)


def retry_job(fighter_name: str) -> bool:
    """
    Force-reset a job to 'queued' so it will be picked up on the next scheduler tick.
    Resets attempt_count to 0 and clears last_error.
    Returns True if the job was found and reset, False if not found.
    """
    with _lock:
        queue = _read()
        found = False
        for j in queue:
            if j["fighter_name"] == fighter_name:
                _backfill_job(j)
                j["status"] = "queued"
                j["attempt_count"] = 0
                j["last_error"] = None
                j["status_updated_at"] = _now_iso()
                found = True
                print(f"[Queue] {fighter_name} manually reset to 'queued' for retry.")
                break
        if found:
            _write(queue)
        return found


def check_stuck_jobs(
    timeout_minutes: int = _STUCK_TIMEOUT_MINUTES,
    max_attempts: int = _MAX_ATTEMPTS,
) -> list[str]:
    """
    Scan for jobs stuck in a non-terminal state for longer than timeout_minutes.

    For each stuck job:
      - Increments attempt_count.
      - Records a timeout error message.
      - If attempt_count < max_attempts: resets status to "queued" (retry).
      - If attempt_count >= max_attempts: marks as "failed".

    Returns the list of fighter names that were acted on.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=timeout_minutes)
    acted: list[str] = []

    with _lock:
        queue = _read()
        changed = False

        # ── Backfill pass: write missing fields to disk so they survive across ticks ──
        # Without this, _backfill_job sets status_updated_at=now in memory only, causing
        # the comparison below to always see a "fresh" timestamp for legacy stuck jobs.
        backfill_changed = False
        for j in queue:
            before_keys = set(j.keys())
            _backfill_job(j)
            if set(j.keys()) != before_keys or (
                "status_updated_at" not in before_keys and j.get("status_updated_at")
            ):
                backfill_changed = True
        if backfill_changed:
            _write(queue)
            # Re-read so the subsequent pass uses the persisted timestamps.
            queue = _read()

        # ── Timeout pass ──────────────────────────────────────────────────────────────
        for j in queue:
            if j["status"] not in _ACTIVE_PROCESSING_STATES:
                continue
            _backfill_job(j)

            ts = j.get("status_updated_at")
            if not ts:
                # No persisted timestamp even after backfill: treat as definitely stale.
                updated_at = cutoff - timedelta(seconds=1)
            else:
                try:
                    updated_at = datetime.fromisoformat(ts)
                    if updated_at.tzinfo is None:
                        updated_at = updated_at.replace(tzinfo=timezone.utc)
                except (ValueError, TypeError):
                    # Unparseable timestamp → treat as stale.
                    updated_at = cutoff - timedelta(seconds=1)

            if updated_at >= cutoff:
                continue

            name = j["fighter_name"]
            j["attempt_count"] += 1
            j["last_error"] = (
                f"Timed out after {timeout_minutes} min in '{j['status']}' state "
                f"(auto-detected on scheduler tick at {_now_iso()})."
            )
            j["status_updated_at"] = _now_iso()

            if j["attempt_count"] >= max_attempts:
                j["status"] = "failed"
                print(
                    f"[Queue] Stuck job {name} marked FAILED after "
                    f"{j['attempt_count']} attempts (timeout={timeout_minutes}m)."
                )
            else:
                j["status"] = "queued"
                print(
                    f"[Queue] Stuck job {name} auto-retried "
                    f"(attempt {j['attempt_count']}/{max_attempts}, timeout={timeout_minutes}m)."
                )

            acted.append(name)
            changed = True

        if changed:
            _write(queue)

    return acted


def clear_old_complete(days: int = 7) -> int:
    """
    Remove 'complete' jobs whose status_updated_at is older than `days` days.
    Returns the number of jobs removed.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)

    with _lock:
        queue = _read()
        before = len(queue)
        kept = []
        for j in queue:
            if j["status"] != "complete":
                kept.append(j)
                continue
            _backfill_job(j)
            try:
                updated_at = datetime.fromisoformat(j["status_updated_at"])
                if updated_at.tzinfo is None:
                    updated_at = updated_at.replace(tzinfo=timezone.utc)
            except Exception:
                updated_at = cutoff
            if updated_at > cutoff:
                kept.append(j)
        removed = before - len(kept)
        if removed > 0:
            _write(kept)
            print(f"[Queue] Auto-cleared {removed} complete job(s) older than {days} days.")
    return removed


def get_job(fighter_name: str) -> dict:
    for j in _read():
        if j["fighter_name"] == fighter_name:
            return _backfill_job(j)
    return {}


def get_all() -> list:
    return [_backfill_job(j) for j in _read()]


def clear_complete():
    with _lock:
        queue = [j for j in _read() if j["status"] != "complete"]
        _write(queue)
