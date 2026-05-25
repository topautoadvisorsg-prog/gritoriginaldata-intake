from datetime import datetime, timezone
from app.database.supabase_client import get_supabase
from app.utils.search_utils import BraveSearch
from app.utils.claude_utils import get_claude
from app.utils.firecrawl_utils import scrape_article
from app.prompts import INTELLIGENCE_HUNT_PROMPT


class IntelligenceAgent:
    """
    Agent 4 — Intelligence Hunter (The Connect).

    Scans news sources and social signals for MMA updates.
    Uses Brave Search to find articles, Firecrawl to fetch full article
    text, and Claude Sonnet to extract structured intelligence signals.
    Stores results in news_articles with headline dedup.
    """

    def __init__(self):
        self.supabase = get_supabase()
        self.search_tool = BraveSearch()

    def run(self) -> str:
        claude = get_claude()

        queries = [
            "MMA breaking news injuries camp changes",
            "UFC fighter withdrawal replacement rumor",
            "top MMA story today",
            "UFC fighter weight cut problems",
            "MMA fighter visa travel issue cancelled",
            "UFC title fight announcement",
            "MMA gym camp change signing",
        ]

        total_recorded = 0
        now_iso = datetime.now(timezone.utc).isoformat()

        for query in queries:
            links = self.search_tool.search(query, count=3)
            for link in links:
                source_url = link.get("url", "")
                title = link.get("title", "")
                snippet = link.get("snippet", "")

                # Dedup by source URL first (fast check before Firecrawl call)
                if source_url:
                    try:
                        dup = (
                            self.supabase.table("news_articles")
                            .select("id")
                            .eq("source_url", source_url)
                            .limit(1)
                            .execute()
                        )
                        if dup.data:
                            print(f"[Agent4] Skipping duplicate URL: {source_url}")
                            continue
                    except Exception as e:
                        print(f"[Agent4] URL dedup check failed: {e}")

                # Fetch full article text via Firecrawl; fall back to snippet
                full_text = None
                if source_url:
                    full_text = scrape_article(source_url, max_chars=8000)
                    if full_text:
                        print(f"[Agent4] Firecrawl fetched {len(full_text)} chars from {source_url}")

                if full_text:
                    content = f"Title: {title}\nFull article:\n{full_text}"
                else:
                    print(f"[Agent4] Firecrawl unavailable — using Brave snippet for: {title}")
                    content = f"Title: {title}\nSnippet: {snippet}"

                signal = claude.analyze(INTELLIGENCE_HUNT_PROMPT, content)

                if not signal or not signal.get("headline"):
                    continue

                headline = signal.get("headline")

                # Dedup by headline
                try:
                    dup_by_title = (
                        self.supabase.table("news_articles")
                        .select("id")
                        .ilike("headline", headline)
                        .limit(1)
                        .execute()
                    )
                    if dup_by_title.data:
                        print(f"[Agent4] Skipping duplicate headline: '{headline}'")
                        continue
                except Exception as e:
                    print(f"[Agent4] Headline dedup check failed: {e}")

                try:
                    layer_val = signal.get("layer") or signal.get("signal_type") or "standard"
                    if layer_val not in ("standard", "intelligence"):
                        layer_val = "intelligence" if signal.get("signal_type") else "standard"
                    summary_text = signal.get("summary") or headline
                    self.supabase.table("news_articles").insert({
                        "headline":    headline,
                        "summary":     summary_text,
                        "layer":       layer_val,
                        "signal_type": signal.get("signal_type") or None,
                        "topic_tags":  signal.get("topic_tags") or signal.get("tags") or [],
                        "author":      "GRIT Data Pipeline",
                        "published_at": now_iso,
                        "is_published": False,
                        "admin_status": "pending",
                        "source_url":  source_url or None,
                    }).execute()
                    total_recorded += 1
                    print(f"[Agent4] Recorded: '{headline}'")
                except Exception as e:
                    print(f"[Agent4] Insert failed: {e}")

        return f"Intelligence sweep complete. Recorded {total_recorded} new articles."
