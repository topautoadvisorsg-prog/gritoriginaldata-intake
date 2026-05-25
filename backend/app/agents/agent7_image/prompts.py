"""
DALL-E 3 prompt for GRIT fighter portrait cards.

Each fighter gets an abstract illustrated half-body portrait that identifies
the fighter by name and weight class in the prompt. The graphic-novel art style
avoids DALL-E 3 content filter false positives that photorealistic prompts trigger.
"""

_BASE_STYLE = (
    "Abstract digital illustration of a combat sports athlete figure. "
    "Half-body portrait composition, head to waist. "
    "Athletic figure in a defensive stance, fists raised. "
    "Style: graphic novel / comic book art with bold ink lines and flat colour blocking. "
    "Very dark near-black background. "
    "Dramatic rim lighting outlining the silhouette from behind. "
    "Cool blue and warm amber accent colours only. "
    "Minimalist sportswear — dark shorts and compression shirt, no text or logos anywhere. "
    "No faces shown — head in shadow or viewed from a dramatic low angle. "
    "No real people, no photographs, purely illustrated artwork. "
    "Clean composition, portrait orientation, cropped at the waist. "
    "Premium sports card illustration style — bold, dark, cinematic."
)


def build_prompt(name: str, weight_class: str | None, nationality: str | None) -> str:
    """
    Build the DALL-E 3 prompt for a fighter's half-body portrait card.

    Includes the fighter's name and weight class so the generation is
    contextually identified — even though the art style is fully abstract
    (no real likeness is rendered). The abstract style avoids content filters
    while still being descriptively tagged by fighter identity for traceability.

    Args:
        name:         Fighter's full name (e.g. "Israel Adesanya").
        weight_class: UFC weight class (e.g. "Middleweight"). Optional.
        nationality:  Fighter's nationality. Used for context only. Optional.
    """
    parts = [_BASE_STYLE]

    if name:
        parts.append(f"Fighter: {name}.")

    if weight_class:
        parts.append(f"Division: {weight_class}.")

    if nationality:
        parts.append(f"Nationality: {nationality}.")

    return " ".join(parts)
