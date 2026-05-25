import re
import os
import base64
import requests
import logging
from typing import Optional, Tuple
from io import BytesIO

logger = logging.getLogger(__name__)

FACE_SIZE: Tuple[int, int] = (1024, 1024)
HALF_BODY_SIZE: Tuple[int, int] = (1024, 1536)

_STORAGE_BUCKET = "fighter-images"
_DALL_E_MODEL = "dall-e-3"

_SHERDOG_CROP_RE = re.compile(r"image_crop/\d+/\d+/(_images/.+)")

_SCRAPE_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Referer": "https://www.sherdog.com/",
}


def _upgrade_sherdog_url(url: str, width: int, height: int) -> str:
    """
    Rewrite a Sherdog image_crop URL to the requested pixel dimensions.
    Sherdog's image server honours arbitrary crop dimensions in the URL path.

    Input:  https://www.sherdog.com/image_crop/200/300/_images/fighter/foo.jpg
    Output: https://www.sherdog.com/image_crop/400/400/_images/fighter/foo.jpg
    """
    m = _SHERDOG_CROP_RE.search(url)
    if m:
        return f"https://www.sherdog.com/image_crop/{width}/{height}/{m.group(1)}"
    return url


# ── Real Photo Handler ─────────────────────────────────────────────────────────

class PhotoProcessor:
    """
    Downloads the real Sherdog fighter photo, resizes it to 400×400, and uploads
    to Supabase Storage as the fighter's headshot (image_url).

    Real photos keep the face recognisable. DALL-E handles the styled body shot.
    """

    def download(self, url: str) -> Optional[bytes]:
        try:
            resp = requests.get(url, headers=_SCRAPE_HEADERS, timeout=15)
            resp.raise_for_status()
            return resp.content if resp.content else None
        except Exception as e:
            logger.error(f"PhotoProcessor: download failed ({url}): {e}")
            return None

    def _resize_crop(self, raw_bytes: bytes, target_w: int, target_h: int) -> Optional[bytes]:
        """PIL fallback: scale-and-center-crop to exact pixel dimensions."""
        try:
            from PIL import Image
            img = Image.open(BytesIO(raw_bytes)).convert("RGB")
            w, h = img.size

            scale = max(target_w / w, target_h / h)
            if abs(scale - 1.0) > 0.001:
                new_w = max(int(w * scale + 0.5), target_w)
                new_h = max(int(h * scale + 0.5), target_h)
                img = img.resize((new_w, new_h), Image.LANCZOS)

            left = (img.width - target_w) // 2
            top = (img.height - target_h) // 2
            img = img.crop((left, top, left + target_w, top + target_h))

            buf = BytesIO()
            img.save(buf, format="JPEG", quality=90, optimize=True)
            return buf.getvalue()
        except Exception as e:
            logger.error(f"PhotoProcessor: PIL resize failed ({target_w}×{target_h}): {e}")
            return None

    def is_url_reachable(self, url: str) -> bool:
        """
        Validate that a URL is accessible before attempting a full download.

        Strategy:
          1. Try HEAD (fast, no body transfer).
          2. If HEAD returns 4xx/5xx or a connection error (some CDNs including
             Sherdog block HEAD while allowing GET), fall back to a range-GET
             for the first 1 byte — a 200 or 206 confirms the resource exists.

        Returns True only if at least one method confirms reachability (2xx/3xx).
        """
        try:
            resp = requests.head(url, headers=_SCRAPE_HEADERS, timeout=8, allow_redirects=True)
            if resp.status_code < 400:
                return True
            logger.debug(
                f"PhotoProcessor: HEAD returned {resp.status_code} for {url} — "
                "falling back to GET range check."
            )
        except Exception as e:
            logger.debug(
                f"PhotoProcessor: HEAD failed for {url} ({e}) — "
                "falling back to GET range check."
            )

        try:
            get_headers = {**_SCRAPE_HEADERS, "Range": "bytes=0-0"}
            resp = requests.get(url, headers=get_headers, timeout=10, allow_redirects=True, stream=True)
            resp.close()
            if resp.status_code in (200, 206):
                logger.debug(f"PhotoProcessor: GET range confirmed reachable: {url}")
                return True
            logger.warning(
                f"PhotoProcessor: URL unreachable (GET {resp.status_code}): {url}"
            )
            return False
        except Exception as e:
            logger.warning(f"PhotoProcessor: GET range check failed for {url}: {e}")
            return False

    def get_face(self, source_url: str) -> Optional[bytes]:
        """
        Download and return a 1024×1024 JPEG of the fighter's face from source_url.

        Steps:
          1. For Sherdog crop URLs: normalize to 1024×1024 first, then validate.
          2. Validate URL is reachable (HEAD request on the normalised URL).
          3. Download raw bytes.
          4. PIL resize/center-crop to exactly 1024×1024.

        Normalising before the reachability check ensures we test the actual
        download URL, not the raw stored path (which may be a partial Sherdog path).
        Returns None if URL is unreachable (Sherdog 403/404) or download fails.
        """
        is_sherdog_crop = bool(_SHERDOG_CROP_RE.search(source_url))
        if is_sherdog_crop:
            url = _upgrade_sherdog_url(source_url, *FACE_SIZE)
        else:
            url = source_url

        if not self.is_url_reachable(url):
            logger.error(f"PhotoProcessor: skipping unreachable URL: {url}")
            return None

        raw = self.download(url)
        return self._resize_crop(raw, *FACE_SIZE) if raw else None

    def upload(
        self,
        image_bytes: bytes,
        fighter_id: str,
        label: str,
        ext: str = "jpg",
        content_type: str = "image/jpeg",
    ) -> Optional[str]:
        """
        Upload image bytes to Supabase Storage. Returns public URL or None.

        Args:
            image_bytes:  Raw image bytes to upload.
            fighter_id:   UUID of the fighter (used as folder name).
            label:        File base name (e.g. "headshot", "body").
            ext:          File extension without dot (default "jpg").
            content_type: MIME type (default "image/jpeg").

        Storage path: fighter-images/{fighter_id}/{label}.{ext}
        """
        try:
            from app.database.supabase_client import get_supabase
            supabase = get_supabase()
            path = f"{fighter_id}/{label}.{ext}"
            try:
                supabase.storage.from_(_STORAGE_BUCKET).upload(
                    path, image_bytes, {"content-type": content_type, "upsert": "true"}
                )
            except Exception:
                supabase.storage.from_(_STORAGE_BUCKET).update(
                    path, image_bytes, {"content-type": content_type}
                )
            url = supabase.storage.from_(_STORAGE_BUCKET).get_public_url(path)
            logger.info(f"Uploaded {label}.{ext} for fighter {fighter_id}: {url}")
            return url
        except Exception as e:
            logger.error(f"Supabase upload failed ({label}.{ext}): {e}")
            return None


# ── DALL-E 3 Styled Body Shot ──────────────────────────────────────────────────

class PortraitGenerator:
    """
    Generates a styled fighter body shot via OpenAI DALL-E 3 using a standard
    consistent prompt. Every fighter gets the same format and visual style —
    dark background, dramatic lighting, fighting stance.

    Output: 1024×1536 px (requested at "1024x1792", PIL center-cropped to 1024×1536).
    """

    def _get_client(self):
        key = os.getenv("OPENAI_API_KEY")
        if not key:
            logger.error(
                "OPENAI_API_KEY not set — cannot generate portrait via DALL-E 3."
            )
            return None
        try:
            from openai import OpenAI
            return OpenAI(api_key=key)
        except ImportError:
            logger.error("openai package not installed.")
            return None

    def _enforce_size_png(self, raw_bytes: bytes) -> bytes:
        """
        Center-crop the DALL-E output from 1024×1792 to exactly 1024×1536 px
        and return as PNG bytes for lossless storage.
        """
        try:
            from PIL import Image
            tw, th = HALF_BODY_SIZE
            img = Image.open(BytesIO(raw_bytes)).convert("RGBA")
            if img.size == (tw, th):
                buf = BytesIO()
                img.save(buf, format="PNG", optimize=True)
                return buf.getvalue()
            scale = max(tw / img.width, th / img.height)
            if abs(scale - 1.0) > 0.001:
                img = img.resize(
                    (max(int(img.width * scale + 0.5), tw),
                     max(int(img.height * scale + 0.5), th)),
                    Image.LANCZOS
                )
            left = (img.width - tw) // 2
            top = (img.height - th) // 2
            img = img.crop((left, top, left + tw, top + th))
            buf = BytesIO()
            img.save(buf, format="PNG", optimize=True)
            return buf.getvalue()
        except Exception as e:
            logger.error(f"Size enforcement (PNG) failed: {e}")
            return raw_bytes

    def generate(self, prompt: str, fighter_id: str) -> Optional[str]:
        """
        Generate a styled half-body portrait via DALL-E 3 and upload to
        Supabase Storage as fighter-images/{fighter_id}/body.png (PNG, 1024×1536).

        The prompt includes the fighter's name and weight class for identity
        traceability, while the abstract illustrated art style avoids content
        filter violations. Returns the public Supabase Storage URL or None.
        """
        client = self._get_client()
        if not client:
            return None
        try:
            logger.info(f"DALL-E 3: generating half-body portrait for fighter {fighter_id}…")
            resp = client.images.generate(
                model=_DALL_E_MODEL,
                prompt=prompt,
                size="1024x1792",
                response_format="b64_json",
                n=1,
            )
            raw_b64 = resp.data[0].b64_json
            if not raw_b64:
                logger.error("DALL-E 3: empty b64_json in response.")
                return None

            raw_bytes = base64.b64decode(raw_b64)
            png_bytes = self._enforce_size_png(raw_bytes)

            processor = PhotoProcessor()
            return processor.upload(
                png_bytes,
                fighter_id,
                label="body",
                ext="png",
                content_type="image/png",
            )
        except Exception as e:
            logger.error(f"DALL-E 3 generation error: {e}")
            return None
