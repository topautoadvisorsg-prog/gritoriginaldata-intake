"""
Signal Fetcher — event-driven, per-fighter Brave searches.

Trusted sources (hardcoded — no broad web scraping):
  mmafighting.com, mmajunkie.usatoday.com, espn.com/mma,
  sherdog.com, bloodyelbow.com, tapology.com
"""
import os
import time
import requests
from typing import Optional

TRUSTED_SOURCES = [
    "mmafighting.com",
    "mmajunkie.usatoday.com",
    "espn.com",
    "sherdog.com",
    "bloodyelbow.com",
    "tapology.com",
]

BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search"
FIRECRAWL_URL    = "https://api.firecrawl.dev/v0/scrape"


def _brave_search(query: str, freshness: str = "pw", count: int = 5) -> list[dict]:
    """Search Brave. Returns list of {title, url, description, published_at}."""
    api_key = os.getenv("BRAVE_API_KEY")
    if not api_key:
        print("[NewsSignals] BRAVE_API_KEY not set")
        return []

    params: dict = {
        "q": query,
        "count": count,
        "text_decorations": False,
        "search_lang": "en",
    }
    if freshness:
        params["freshness"] = freshness

    try:
        resp = requests.get(
            BRAVE_SEARCH_URL,
            headers={
                "Accept": "application/json",
                "Accept-Encoding": "gzip",
                "X-Subscription-Token": api_key,
            },
            params=params,
            timeout=10,
        )
        resp.raise_for_status()
        results = []
        for item in resp.json().get("web", {}).get("results", []):
            url = item.get("url", "")
            # Only keep results from trusted sources
            if not any(src in url for src in TRUSTED_SOURCES):
                continue
            results.append({
                "title":        item.get("title", ""),
                "url":          url,
                "description":  item.get("description", ""),
                "published_at": item.get("page_age") or item.get("age"),
            })
        return results
    except Exception as e:
        print(f"[NewsSignals] Brave error for '{query}': {e}")
        return []


def search_for_fighter(
    fighter_name: str,
    freshness: str = "pw",
    known_urls: Optional[set] = None,
) -> list[dict]:
    """
    Search for intelligence signals about a specific fighter.
    Searches across all trusted domains in one query.

    Args:
        fighter_name: "Conor McGregor"
        freshness:    Brave param: pd=1day, pw=1week, pm=1month, py=1year
        known_urls:   Set of already-processed URLs to skip

    Returns:
        List of raw article dicts for Claude to classify.
    """
    known_urls = known_urls or set()
    query = (
        f'"{fighter_name}" MMA '
        f'(injury OR "pulls out" OR "drops out" OR camp OR weight OR training OR replacement OR hospitalized)'
    )

    print(f"[NewsSignals] Searching for '{fighter_name}' | freshness={freshness}")
    results = _brave_search(query, freshness=freshness, count=8)
    time.sleep(0.3)

    articles = []
    for r in results:
        url = r.get("url", "")
        if not url or url in known_urls:
            continue
        content = r.get("description", "")
        if not content:
            continue
        articles.append({
            "fighter_name":  fighter_name,
            "source_name":   _source_label(url),
            "title":         r["title"],
            "url":           url,
            "content":       content,
            "published_at":  r.get("published_at"),
        })

    print(f"[NewsSignals] Found {len(articles)} new articles for '{fighter_name}'")
    return articles


def _source_label(url: str) -> str:
    mapping = {
        "mmafighting.com":       "MMA Fighting",
        "mmajunkie":             "MMA Junkie",
        "espn.com":              "ESPN MMA",
        "sherdog.com":           "Sherdog",
        "bloodyelbow.com":       "Bloody Elbow",
        "tapology.com":          "Tapology",
    }
    for key, label in mapping.items():
        if key in url:
            return label
    return "Unknown"
