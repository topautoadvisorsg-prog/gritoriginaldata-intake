-- Migration 009: Add unique constraint to fight_history for ON CONFLICT upserts
-- Required by Agent 3 batch upsert: ON CONFLICT (fighter_id, event_name, opponent_name)
-- Safe to run even if constraint already exists.
-- Run this in your Supabase SQL Editor.

ALTER TABLE fight_history
  ADD CONSTRAINT IF NOT EXISTS fight_history_fighter_event_opponent_unique
  UNIQUE (fighter_id, event_name, opponent_name);

-- Also ensure fight_history table has all fields Agent 3 writes
ALTER TABLE fight_history ADD COLUMN IF NOT EXISTS event_promotion TEXT;
ALTER TABLE fight_history ADD COLUMN IF NOT EXISTS fighter_name    TEXT;
ALTER TABLE fight_history ADD COLUMN IF NOT EXISTS method_detail   TEXT;
ALTER TABLE fight_history ADD COLUMN IF NOT EXISTS rounds_scheduled INT;
ALTER TABLE fight_history ADD COLUMN IF NOT EXISTS fight_duration_seconds INT;
ALTER TABLE fight_history ADD COLUMN IF NOT EXISTS fight_type      TEXT;
ALTER TABLE fight_history ADD COLUMN IF NOT EXISTS billing         TEXT;
ALTER TABLE fight_history ADD COLUMN IF NOT EXISTS bout_order      INT;
ALTER TABLE fight_history ADD COLUMN IF NOT EXISTS location        JSONB;

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS fight_history_fighter_id_idx ON fight_history (fighter_id);
CREATE INDEX IF NOT EXISTS fight_history_event_date_idx ON fight_history (event_date DESC);
