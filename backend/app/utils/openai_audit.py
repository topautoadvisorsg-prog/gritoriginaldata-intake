"""
OpenAI Audit Layer — compares raw source text against Claude-parsed output.

Rules (non-negotiable):
  - OpenAI NEVER modifies data
  - OpenAI ONLY flags mismatches between raw text and parsed output
  - Result: {"status": "ok"|"mismatch"|"skipped"|"error", "issues": [...]}
"""
import os
import json
from openai import OpenAI
from dotenv import load_dotenv

load_dotenv()

AUDIT_SYSTEM_PROMPT = """You are a data validation agent.

Your ONLY job is to compare RAW TEXT (the source of truth) against PARSED DATA and flag mismatches.

ABSOLUTE RULES:
- Do NOT guess or infer anything
- Do NOT suggest corrections
- Do NOT modify the parsed data
- ONLY detect where parsed_data disagrees with what the raw text explicitly states

Focus especially on:
- fight result (Win/Loss/Draw/NC) — check that "W", "def.", "winner" in raw text matches parsed result
- opponent name — check spelling matches
- event name — check it appears in raw text
- method (KO/TKO/Submission/Decision)

If every parsed field accurately reflects the raw text, return:
{"status": "ok", "issues": []}

If any mismatch exists, return:
{
  "status": "mismatch",
  "issues": [
    {
      "field": "result",
      "raw_value": "W",
      "parsed_value": "Loss",
      "reason": "Raw text shows 'W' (Win) but parsed result is Loss"
    }
  ]
}

Return ONLY valid JSON. No commentary, no code fences."""


def audit_parse(raw_text: str, parsed_data) -> dict:
    """
    Audit whether parsed_data accurately reflects raw_text.

    Args:
        raw_text:    The exact pasted text from the operator.
        parsed_data: Claude's parsed output (list of bouts or dict).

    Returns:
        {
          "status": "ok" | "mismatch" | "skipped" | "error",
          "issues": [{"field", "raw_value", "parsed_value", "reason"}, ...]
        }
    """
    key = os.getenv("OPENAI_API_KEY")
    if not key:
        return {"status": "skipped", "issues": [], "reason": "OPENAI_API_KEY not set"}

    client = OpenAI(api_key=key)

    # Limit lengths to control cost — raw text first 3000 chars, parsed 2000
    raw_excerpt  = raw_text[:3000]
    parsed_excerpt = json.dumps(parsed_data, indent=2)[:2000]

    user_content = f"RAW TEXT:\n{raw_excerpt}\n\nPARSED DATA:\n{parsed_excerpt}"

    try:
        response = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": AUDIT_SYSTEM_PROMPT},
                {"role": "user", "content": user_content},
            ],
            response_format={"type": "json_object"},
            max_tokens=800,
            temperature=0,
        )
        content = response.choices[0].message.content
        result = json.loads(content)
        print(f"[OpenAI Audit] status={result.get('status')} issues={len(result.get('issues', []))}")
        return result

    except Exception as e:
        print(f"[OpenAI Audit] Error: {e}")
        return {"status": "error", "issues": [], "error": str(e)}
