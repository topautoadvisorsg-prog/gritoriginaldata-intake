-- Migration 004: Unique indexes for fight_history dedup and news_articles source_url
--
-- fight_history: Agent 3 now uses upsert with ON CONFLICT (fighter_id, event_name, opponent_name).
-- This unique index is required for the ON CONFLICT clause to work correctly.
-- If two bouts have the same fighter, event, and opponent (re-run scenario),
-- the upsert will update instead of inserting a duplicate row.

CREATE UNIQUE INDEX IF NOT EXISTS fight_history_fighter_event_opponent_idx
    ON fight_history (fighter_id, event_name, opponent_name);


-- news_articles: Agent 4 now stores source_url and deduplicates by it.
-- Add the source_url column if it doesn't exist, then add a unique index
-- (partial — only for non-null values, since some articles may not have a URL).

ALTER TABLE news_articles
    ADD COLUMN IF NOT EXISTS source_url TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS news_articles_source_url_idx
    ON news_articles (source_url)
    WHERE source_url IS NOT NULL;
