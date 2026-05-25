-- Migration 010: Add aliases column to fighters table
-- Agent 2 stores known alternate name spellings as a text array.
-- Run this in your Supabase SQL Editor.

ALTER TABLE fighters ADD COLUMN IF NOT EXISTS aliases TEXT[] DEFAULT '{}';

CREATE INDEX IF NOT EXISTS fighters_aliases_idx ON fighters USING GIN (aliases);
