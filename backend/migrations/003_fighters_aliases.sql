-- Migration 003: Add aliases column to fighters table
-- Run this in the Supabase SQL Editor at:
-- https://supabase.com/dashboard/project/<your-project>/sql
--
-- Purpose: Tracks known name variants for each fighter (e.g. "Jon Jones" / "Jonathan Jones")
-- Used by the data engine's fuzzy dedup system to prevent duplicate fighter records
-- when the same athlete appears under slightly different names across data sources.

ALTER TABLE public.fighters
    ADD COLUMN IF NOT EXISTS aliases JSONB NOT NULL DEFAULT '[]'::JSONB;

-- Optional: Index for containment queries used by find_fighter_by_name
CREATE INDEX IF NOT EXISTS idx_fighters_aliases ON public.fighters USING GIN (aliases);

COMMENT ON COLUMN public.fighters.aliases IS
    'JSON array of known name variants for this fighter, e.g. ["Jon Jones", "Jonathan Jones"]. '
    'Maintained by the GRIT Data Engine fuzzy dedup system.';
