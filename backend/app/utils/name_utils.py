"""
Fighter name normalization, fuzzy deduplication, and alias tracking utilities.

Lookup strategy (in order):
  1. Case-insensitive exact match on normalized first+last name
  2. Alias containment — check if the query name appears in the stored aliases list
  3. Fuzzy match via SequenceMatcher at threshold 0.75 against last-name-initial candidates

When a fuzzy/alias match fires, call update_fighter_aliases() to record the
new name variant so future lookups are faster and more reliable.

SCHEMA NOTE: The fighters table requires an `aliases` JSONB column.
Run backend/migrations/003_fighters_aliases.sql to add it.
If the column is absent, alias checks are silently skipped and a warning is logged.
"""
import json
import re
import unicodedata
from difflib import SequenceMatcher
from typing import List, Optional, Tuple


def normalize_name(full_name: str) -> Tuple[str, str]:
    """
    Normalize a full fighter name into (first_name, last_name).

    Steps:
      1. Unicode NFKD → ASCII (José → Jose, İslam → Islam)
      2. Lowercase
      3. Strip leading/trailing whitespace
      4. Collapse internal whitespace to single space
      5. Remove characters that are not letters, hyphens, or spaces

    Returns:
      (first_name, last_name) tuple, both normalized and lowercase.
      If the name is a single word, last_name is "".
    """
    if not full_name:
        return ("", "")

    nfkd = unicodedata.normalize("NFKD", full_name)
    ascii_name = nfkd.encode("ascii", "ignore").decode("ascii")
    cleaned = re.sub(r"[^a-zA-Z\s\-]", "", ascii_name)
    collapsed = re.sub(r"\s+", " ", cleaned).strip().lower()

    parts = collapsed.split(" ")
    first = parts[0] if parts else ""
    last = " ".join(parts[1:]) if len(parts) > 1 else ""
    return (first, last)


def _similarity(a: str, b: str) -> float:
    return SequenceMatcher(None, a, b).ratio()


def _merge_aliases(existing_aliases, new_name: str) -> List[str]:
    """Return a deduplicated alias list that includes new_name (normalized lowercase).

    Aliases are stored normalized so that the JSONB containment query in
    find_fighter_by_name (which looks up the normalized full_norm string) reliably
    hits them. Raw-case variants are safe to pass in; they will be lowercased here.
    """
    if isinstance(existing_aliases, str):
        try:
            existing_aliases = json.loads(existing_aliases)
        except Exception:
            existing_aliases = []
    aliases = list(existing_aliases) if existing_aliases else []
    # Normalize before storing so containment queries always match.
    norm_first, norm_last = normalize_name(new_name)
    normalized = f"{norm_first} {norm_last}".strip()
    if normalized and normalized not in aliases:
        aliases.append(normalized)
    return aliases


def find_fighter_by_name(
    supabase,
    first_name: str,
    last_name: str,
    fuzzy_threshold: float = 0.75,
) -> Optional[dict]:
    """
    Look up a fighter in the DB using a three-stage strategy:

    1. Case-insensitive exact match on normalized first+last name (ilike).
    2. Alias containment — query rows whose aliases JSONB array contains the
       full normalized name string (handles previously recorded variants).
    3. Fuzzy SequenceMatcher match at threshold 0.75 against candidates whose
       last_name starts with the same first character — catches "Jon" / "Jonathan"
       which scores 0.78, safely above the 0.75 threshold.

    Returns the matching fighter row dict (with at least "id") or None.
    """
    norm_first, norm_last = normalize_name(f"{first_name} {last_name}")
    full_norm = f"{norm_first} {norm_last}".strip()

    # ── Stage 1: Exact normalized match ──────────────────────────────────────
    try:
        res = (
            supabase.table("fighters")
            .select("id, first_name, last_name")
            .ilike("first_name", norm_first)
            .ilike("last_name", norm_last)
            .execute()
        )
        if res.data:
            return res.data[0]
    except Exception as e:
        print(f"[name_utils] Exact lookup error for '{full_norm}': {e}")

    # ── Stage 2: Alias containment check ─────────────────────────────────────
    try:
        alias_res = (
            supabase.table("fighters")
            .select("id, first_name, last_name")
            .filter("aliases", "cs", json.dumps([full_norm]))
            .execute()
        )
        if alias_res.data:
            print(f"[name_utils] Alias match: '{full_norm}' found in aliases.")
            return alias_res.data[0]
    except Exception:
        pass

    # ── Stage 3: Fuzzy match on last-name-initial candidates ─────────────────
    if not norm_last:
        return None

    try:
        candidates_res = (
            supabase.table("fighters")
            .select("id, first_name, last_name")
            .ilike("last_name", f"{norm_last[0]}%")
            .execute()
        )
        candidates = candidates_res.data or []
    except Exception:
        return None

    best_score = 0.0
    best_match = None
    for c in candidates:
        c_norm_first, c_norm_last = normalize_name(
            f"{c.get('first_name', '')} {c.get('last_name', '')}"
        )
        c_full = f"{c_norm_first} {c_norm_last}".strip()
        score = _similarity(full_norm, c_full)
        if score > best_score:
            best_score = score
            best_match = c

    if best_score >= fuzzy_threshold:
        print(
            f"[name_utils] Fuzzy match: '{full_norm}' → "
            f"'{best_match.get('first_name')} {best_match.get('last_name')}' "
            f"(score={best_score:.2f}, threshold={fuzzy_threshold})"
        )
        return best_match

    return None


def update_fighter_aliases(supabase, fighter_id: str, new_name_variant: str) -> None:
    """
    Append new_name_variant to the aliases list for the given fighter.
    Silently skips if the aliases column does not exist (logs a warning).
    """
    try:
        res = (
            supabase.table("fighters")
            .select("aliases")
            .eq("id", fighter_id)
            .single()
            .execute()
        )
        existing = res.data.get("aliases") if res.data else None
        updated = _merge_aliases(existing, new_name_variant)
        supabase.table("fighters").update({"aliases": updated}).eq("id", fighter_id).execute()
        print(f"[name_utils] Aliases updated for {fighter_id}: {updated}")
    except Exception as e:
        print(
            f"[name_utils] Could not update aliases for {fighter_id} "
            f"(run migration 003_fighters_aliases.sql if column is missing): {e}"
        )
