import os
import logging
from typing import Optional

logger = logging.getLogger(__name__)

_client = None


def get_firecrawl():
    global _client
    if _client is None:
        try:
            from firecrawl import FirecrawlApp
            api_key = os.getenv("FIRECRAWL_API_KEY")
            if not api_key:
                raise ValueError("FIRECRAWL_API_KEY not set")
            _client = FirecrawlApp(api_key=api_key)
        except Exception as e:
            logger.error(f"[Firecrawl] Failed to initialize: {e}")
            _client = None
    return _client


def scrape_url(url: str, timeout: int = 30000) -> Optional[str]:
    """
    Scrape a URL with Firecrawl and return clean markdown text.
    Returns None if scraping fails (caller should fall back gracefully).
    """
    try:
        fc = get_firecrawl()
        if not fc:
            return None
        result = fc.scrape(url, formats=["markdown"])
        if isinstance(result, dict):
            return result.get("markdown") or result.get("content") or None
        if hasattr(result, "markdown"):
            return result.markdown
        return None
    except Exception as e:
        logger.warning(f"[Firecrawl] scrape_url failed for {url}: {e}")
        return None


def scrape_article(url: str, max_chars: int = 8000) -> Optional[str]:
    """
    Scrape a news article URL. Returns truncated markdown for Claude input.
    Falls back to None if Firecrawl is unavailable or fails.
    """
    text = scrape_url(url)
    if not text:
        return None
    return text[:max_chars]
