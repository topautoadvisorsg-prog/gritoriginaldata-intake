import logging
from app.database.supabase_client import get_supabase
from .generator import PhotoProcessor, PortraitGenerator
from .prompts import build_prompt

logger = logging.getLogger(__name__)

_STORAGE_BUCKET = "fighter-images"
_PLACEHOLDER_MARKERS = ("via.placeholder.com", "placeholder", "")


class ImageAgent:
    """
    Agent 7 — Image Processor.

    Produces TWO images per fighter:

      image_url      — Real fighter headshot scraped from Sherdog (1024×1024 JPEG).
                       Downloaded from the Sherdog photo URL already stored by Agent 2,
                       normalised to 1024×1024 using Sherdog's CDN crop URL scheme and
                       center-cropped via PIL, then uploaded to Supabase Storage as
                       fighter-images/{fighter_id}/headshot.jpg.

      body_image_url — Styled half-body portrait generated via DALL-E 3 (1024×1536 PNG).
                       Prompt includes fighter name and weight class for traceability.
                       Abstract illustrated (graphic-novel) art style avoids content
                       filter issues. Uploaded to fighter-images/{fighter_id}/body.png.

    If the Sherdog headshot is unavailable:
      - sets needs_image = True on the fighter record
      - still attempts the DALL-E body shot (independent step)

    On startup the agent verifies that the Supabase Storage bucket 'fighter-images'
    exists and has public read access. If not, a RuntimeError is raised immediately
    with an actionable message so the failure is unmistakable in the pipeline logs —
    no fighters are processed and no API spend is wasted.
    """

    def __init__(self):
        self.supabase = get_supabase()
        self.photo = PhotoProcessor()
        self.portrait = PortraitGenerator()
        self._assert_bucket_ready()

    def _assert_bucket_ready(self) -> None:
        """
        Verifies the 'fighter-images' Supabase Storage bucket exists and is public.

        Raises RuntimeError with an actionable message if the bucket is missing
        or private so that the failure is immediately visible in the pipeline logs
        rather than silently skipping every fighter.
        """
        try:
            buckets = self.supabase.storage.list_buckets()
        except Exception as e:
            raise RuntimeError(
                f"Agent 7: cannot connect to Supabase Storage: {e}. "
                "Check SUPABASE_URL and SUPABASE_SERVICE_KEY."
            ) from e

        for bucket in buckets:
            if isinstance(bucket, dict):
                name = bucket.get("name", "")
                is_public = bucket.get("public", False)
            else:
                name = getattr(bucket, "name", "")
                is_public = getattr(bucket, "public", False)

            if name == _STORAGE_BUCKET:
                if is_public:
                    logger.info(
                        f"Agent 7: bucket '{_STORAGE_BUCKET}' confirmed ready "
                        "(exists, public=True)."
                    )
                    return
                raise RuntimeError(
                    f"Agent 7: bucket '{_STORAGE_BUCKET}' exists but is NOT public. "
                    "Fix: Supabase Dashboard → Storage → fighter-images → Edit → "
                    "enable 'Public bucket', then restart the pipeline."
                )

        raise RuntimeError(
            f"Agent 7: bucket '{_STORAGE_BUCKET}' does NOT exist. "
            "Fix: Supabase Dashboard → Storage → New bucket → "
            f"name='{_STORAGE_BUCKET}', Public=ON, then restart the pipeline."
        )

    def _is_placeholder(self, url: str) -> bool:
        if not url:
            return True
        return any(m in url for m in _PLACEHOLDER_MARKERS if m)

    def run(self, fighter_id: str, fighter_name: str):
        logger.info(f"Agent 7: processing {fighter_name} ({fighter_id})")

        # ── Fetch fighter record ───────────────────────────────────────────────
        res = (
            self.supabase.table("fighters")
            .select("image_url, weight_class, nationality, first_name, last_name")
            .eq("id", fighter_id)
            .single()
            .execute()
        )
        if not res.data:
            logger.error(f"Agent 7: no fighter record found for {fighter_id}.")
            return

        record = res.data
        source_url = record.get("image_url") or ""
        weight_class = record.get("weight_class")
        nationality = record.get("nationality")
        name = f"{record.get('first_name', '')} {record.get('last_name', '')}".strip() or fighter_name

        updates: dict = {}

        # ── Step 1: Real headshot from Sherdog → image_url (1024×1024) ──────────
        # PhotoProcessor validates URL reachability before attempting the download.
        # If the Sherdog CDN returns 403/404 (common for older fighters), the
        # headshot is skipped but the body shot still runs independently.
        if self._is_placeholder(source_url):
            logger.warning(
                f"Agent 7: no Sherdog photo for {fighter_name}. "
                "Setting needs_image=True."
            )
            updates["needs_image"] = True
        else:
            face_bytes = self.photo.get_face(source_url)
            if face_bytes:
                face_url = self.photo.upload(face_bytes, fighter_id, "headshot")
                if face_url:
                    updates["image_url"] = face_url
                    updates["needs_image"] = False
                    updates["image_source"] = "sherdog"
                    logger.info(
                        f"Agent 7: headshot uploaded for {fighter_name} "
                        f"({len(face_bytes)//1024}KB, 1024×1024 px)."
                    )
                else:
                    logger.error(f"Agent 7: headshot upload to Supabase Storage failed for {fighter_name}.")
                    updates["needs_image"] = True
            else:
                logger.error(
                    f"Agent 7: headshot download failed for {fighter_name} "
                    f"(URL: {source_url[:80]}). Clearing image_url and setting needs_image=True."
                )
                updates["needs_image"] = True
                updates["image_url"] = None

        # ── Step 2: DALL-E 3 body shot → body_image_url (1024×1536 PNG) ──────
        # Always attempt regardless of headshot success. The body shot is an
        # abstract illustrated style (graphic-novel / comic-book art) — no real
        # likeness, no content filter issues. Stored as body.png in Supabase.
        prompt = build_prompt(name, weight_class, nationality)
        body_url = self.portrait.generate(prompt, fighter_id)
        if body_url:
            updates["body_image_url"] = body_url
            updates["ai_generated"] = True
            logger.info(f"Agent 7: DALL-E 3 body shot ready for {fighter_name}.")
        else:
            logger.error(f"Agent 7: DALL-E 3 body shot generation failed for {fighter_name}.")

        # ── Persist both updates in one call ───────────────────────────────────
        # ai_generated and image_source require migration 011. If the columns
        # don't exist yet, retry without them so images are always saved.
        if updates:
            try:
                self.supabase.table("fighters").update(updates).eq(
                    "id", fighter_id
                ).execute()
                logger.info(
                    f"Agent 7: DB updated for {fighter_name}. Fields: {list(updates.keys())}"
                )
            except Exception as e:
                if "ai_generated" in str(e) or "image_source" in str(e):
                    logger.warning(
                        f"Agent 7: ai_generated/image_source columns missing — "
                        "run migration 011 in Supabase. Retrying without these fields."
                    )
                    safe_updates = {
                        k: v for k, v in updates.items()
                        if k not in ("ai_generated", "image_source")
                    }
                    if safe_updates:
                        self.supabase.table("fighters").update(safe_updates).eq(
                            "id", fighter_id
                        ).execute()
                        logger.info(
                            f"Agent 7: DB updated (partial) for {fighter_name}. "
                            f"Fields: {list(safe_updates.keys())}"
                        )
                else:
                    logger.error(f"Agent 7: DB update failed for {fighter_name}: {e}")
