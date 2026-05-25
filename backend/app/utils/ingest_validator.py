"""
Validation layer for manual ingestion.
Returns a list of error strings. Empty list = valid.
"""
from typing import Any


def validate_fighter_profile(data: dict) -> list[str]:
    errors: list[str] = []

    # ── Tier 1: Hard blockers ─────────────────────────────────────────────────
    if not data.get("first_name") or not str(data["first_name"]).strip():
        errors.append("first_name is required")
    if not data.get("last_name") or not str(data["last_name"]).strip():
        errors.append("last_name is required")
    if data.get("wins") is None:
        errors.append("wins is required (set to 0 if fighter has no wins)")
    if data.get("losses") is None:
        errors.append("losses is required (set to 0 if fighter has no losses)")
    if not data.get("weight_class"):
        errors.append("weight_class is required")

    # ── Number sanity checks ──────────────────────────────────────────────────
    for field in ("wins", "losses", "draws", "nc", "ko_wins", "tko_wins",
                  "sub_wins", "dec_wins", "losses_by_ko",
                  "losses_by_submission", "losses_by_decision"):
        val = data.get(field)
        if val is not None:
            try:
                v = int(val)
                if v < 0:
                    errors.append(f"{field} cannot be negative (got {val})")
            except (TypeError, ValueError):
                errors.append(f"{field} must be an integer (got {val!r})")

    for field in ("height_inch", "reach_inch"):
        val = data.get(field)
        if val is not None:
            try:
                v = float(val)
                if v < 50 or v > 100:
                    errors.append(
                        f"{field} looks invalid ({val}) — expected between 50–100 inches"
                    )
            except (TypeError, ValueError):
                errors.append(f"{field} must be a number (got {val!r})")

    # ── Enum checks ───────────────────────────────────────────────────────────
    stance = data.get("stance")
    if stance and stance not in ("Orthodox", "Southpaw", "Switch"):
        errors.append(
            f"stance must be Orthodox, Southpaw, or Switch (got {stance!r})"
        )

    # ── Empty payload check ───────────────────────────────────────────────────
    meaningful_fields = [
        "height_inch", "reach_inch", "nationality", "weight_class",
        "gym", "date_of_birth", "ko_wins", "sub_wins", "dec_wins",
    ]
    has_meaningful = any(
        data.get(f) not in (None, "", 0) for f in meaningful_fields
    )
    if not has_meaningful and not errors:
        errors.append(
            "Profile contains no useful data beyond name/record — "
            "check that you pasted the full profile page"
        )

    return errors


def validate_fight_history(bouts: list) -> list[str]:
    errors: list[str] = []

    if not isinstance(bouts, list):
        return ["fight_history data must be a list of bouts"]

    if len(bouts) == 0:
        return ["No bouts found — check that you pasted the fight history section"]

    for i, bout in enumerate(bouts):
        if not isinstance(bout, dict):
            errors.append(f"Bout #{i + 1} is not a valid object")
            continue
        if not bout.get("opponent_name"):
            errors.append(f"Bout #{i + 1} is missing opponent_name")
        result = bout.get("result")
        if result and result not in ("Win", "Loss", "Draw", "NC"):
            errors.append(
                f"Bout #{i + 1}: result must be Win/Loss/Draw/NC (got {result!r})"
            )

    return errors
