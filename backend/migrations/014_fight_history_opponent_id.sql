-- Migration 014: Link fight_history to the opponent's fighter record
-- Run in Supabase SQL Editor.  Safe to apply multiple times (IF NOT EXISTS / IF EXISTS).
--
-- WHY
-- ---
-- fight_history.opponent_name is plain text.  When the opponent already exists in
-- the fighters table we now store their UUID so queries can JOIN properly instead
-- of relying on fuzzy name matching at query time.
--
-- The column is NULLABLE — opponents ingested before this migration, or opponents
-- who are not yet in the DB, remain NULL.  The ingest approve endpoint auto-creates
-- a minimal "shell" fighter record for unknown opponents and stores their new ID here.

ALTER TABLE fight_history
    ADD COLUMN IF NOT EXISTS opponent_id UUID REFERENCES fighters(id) ON DELETE SET NULL;

-- Index for reverse lookups: "all fights this fighter appears in as an opponent"
CREATE INDEX IF NOT EXISTS fight_history_opponent_id_idx
    ON fight_history (opponent_id)
    WHERE opponent_id IS NOT NULL;
