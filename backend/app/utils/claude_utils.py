import os
import json
import time
from anthropic import Anthropic
from dotenv import load_dotenv

load_dotenv()


class ClaudeEmptyResponseError(Exception):
    """
    Raised by ClaudeClient.analyze() when Claude returns an empty dict,
    invalid JSON, or a response missing required fields.

    Callers should catch this, mark the pipeline job as 'error', and
    skip any DB upsert rather than writing garbage defaults.
    """
    pass


class ClaudeOverloadedError(Exception):
    """Raised when Anthropic returns a 529 overload error after all retries."""
    pass


def _extract_json(text: str) -> str:
    """
    Extract the first complete JSON value (object or array) from a text string.
    Handles both ``` fences and bare JSON.
    """
    # Strip markdown code fences first
    if "```json" in text:
        text = text.split("```json")[1].split("```")[0].strip()
    elif "```" in text:
        text = text.split("```")[1].split("```")[0].strip()

    text = text.strip()

    # Find the first JSON value (array or object)
    for start_ch, end_ch in [("[", "]"), ("{", "}")]:
        idx = text.find(start_ch)
        if idx != -1:
            ridx = text.rfind(end_ch)
            if ridx != -1 and ridx > idx:
                return text[idx:ridx + 1]

    return text


class ClaudeClient:
    def __init__(self):
        self.model = "claude-sonnet-4-6"
        self._client = None

    @property
    def client(self):
        if self._client is None:
            key = os.getenv("ANTHROPIC_API_KEY")
            if not key:
                raise ValueError(
                    "ANTHROPIC_API_KEY is not set. Enter it in the API Keys panel."
                )
            self._client = Anthropic(api_key=key)
        return self._client

    def analyze(
        self,
        system_prompt: str,
        user_content: str,
        required_keys: list = None,
        max_retries: int = 3,
    ) -> dict:
        """
        Call Claude and parse the JSON response. Retries automatically on
        transient 529 overload errors (up to max_retries times).

        Args:
            system_prompt: The system instruction prompt.
            user_content: The user-facing content/data.
            required_keys: If provided, raises ClaudeEmptyResponseError when
                           any of these keys are absent from the parsed result.
            max_retries: How many times to retry on 529 overload.

        Returns:
            Parsed dict or list from Claude's response.

        Raises:
            ClaudeEmptyResponseError: If Claude returns empty/unparseable JSON.
            ClaudeOverloadedError: If Claude is overloaded after all retries.
        """
        raw_response = None
        last_error = None

        for attempt in range(1, max_retries + 1):
            try:
                message = self.client.messages.create(
                    model=self.model,
                    max_tokens=4096,
                    system=system_prompt,
                    messages=[{"role": "user", "content": user_content}]
                )
                raw_response = message.content[0].text
                content = _extract_json(raw_response)
                result = json.loads(content)

                if not result and result != 0:
                    raise ClaudeEmptyResponseError(
                        f"Claude returned empty result. Raw: {raw_response!r}"
                    )

                if required_keys and isinstance(result, dict):
                    missing = [k for k in required_keys if k not in result]
                    if missing:
                        raise ClaudeEmptyResponseError(
                            f"Claude response missing required keys: {missing}. "
                            f"Got: {list(result.keys())}. Raw: {raw_response!r}"
                        )

                return result

            except (json.JSONDecodeError, IndexError, ValueError) as e:
                print(f"[ClaudeClient] JSON parse error (attempt {attempt}): {e}")
                print(f"[ClaudeClient] Raw response: {raw_response!r}")
                raise ClaudeEmptyResponseError(
                    f"Claude returned unparseable JSON: {e}. Raw: {raw_response!r}"
                )

            except ClaudeEmptyResponseError:
                raise

            except Exception as e:
                err_str = str(e)
                is_overload = "529" in err_str or "overloaded" in err_str.lower()
                print(f"[ClaudeClient] API error (attempt {attempt}): {e}")

                if is_overload and attempt < max_retries:
                    wait = 2 ** attempt  # 2s, 4s, 8s
                    print(f"[ClaudeClient] Overloaded — retrying in {wait}s...")
                    time.sleep(wait)
                    last_error = e
                    continue

                if is_overload:
                    raise ClaudeOverloadedError(
                        f"Anthropic API is overloaded. Please try again in a moment. ({e})"
                    )

                raise ClaudeEmptyResponseError(f"Claude API call failed: {e}")

        raise ClaudeOverloadedError(
            f"Anthropic API still overloaded after {max_retries} retries. ({last_error})"
        )


_claude = ClaudeClient()


def get_claude():
    return _claude


