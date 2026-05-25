-- Migration 013: Source URL column for external identity anchoring
--               + belt-and-suspenders fight_history dedup index
-- Run in Supabase SQL Editor.  Safe to apply multiple times (all IF NOT EXISTS).
--
-- PURPOSE
-- -------
-- Phase-1 (this migration): add source_url / source_id columns so every fighter
-- record can be anchored to its canonical UFCStats URL.  The ingest flow stores
-- these during parse; future deduplication uses them as the primary identity key
-- instead of name-matching alone.
--
-- Phase-2 (future): once source_url is populated for the full roster, a second
-- migration will promote it to a UNIQUE NOT NULL column and replace name-based
-- lookup with a source_id lookup where possible.

-- ── Fighters: external identity columns ───────────────────────────────────────

ALTER TABLE fighters
    ADD COLUMN IF NOT EXISTS source_url  TEXT;          -- canonical UFCStats profile URL

ALTER TABLE fighters
    ADD COLUMN IF NOT EXISTS source_id   TEXT;          -- extracted ID from that URL
                                                        -- e.g. "Jon-Jones-27944" from Sherdog
                                                        -- or a UFCStats numeric ID

-- Partial unique index: when a source_url is present it must be globally unique.
-- NULL rows (fighters ingested before this migration) are excluded so the index
-- does not block existing data.
CREATE UNIQUE INDEX IF NOT EXISTS fighters_source_url_unique_idx
    ON fighters (source_url)
    WHERE source_url IS NOT NULL;

-- ── fight_history: belt-and-suspenders dedup index ───────────────────────────
-- Migrations 004 + 009 may have already created this; IF NOT EXISTS is safe.
-- The ingest approve endpoint now uses upsert with on_conflict targeting these
-- columns, so the index MUST exist for ON CONFLICT to resolve correctly.

CREATE UNIQUE INDEX IF NOT EXISTS fight_history_dedup_belt_idx
    ON fight_history (fighter_id, event_name, opponent_name);

-- Optional diagnostic: uncomment to verify dedup index is present
-- SELECT indexname, indexdef
-- FROM pg_indexes
-- WHERE tablename = 'fight_history'
--   AND indexname LIKE '%dedup%';
