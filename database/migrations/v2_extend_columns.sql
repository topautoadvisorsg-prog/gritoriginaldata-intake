-- Migration v2 — Extend columns to match GRIT v2.0 spec
-- Run this against the existing Supabase instance.
-- All statements use IF NOT EXISTS / safe defaults so they are idempotent.

-- ── fighters ──────────────────────────────────────────────────────────────────

ALTER TABLE fighters ADD COLUMN IF NOT EXISTS gender TEXT;
ALTER TABLE fighters ADD COLUMN IF NOT EXISTS organization TEXT;
ALTER TABLE fighters ADD COLUMN IF NOT EXISTS leg_reach_cm NUMERIC;
ALTER TABLE fighters ADD COLUMN IF NOT EXISTS stance TEXT;
ALTER TABLE fighters ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';
ALTER TABLE fighters ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;
ALTER TABLE fighters ADD COLUMN IF NOT EXISTS is_champion BOOLEAN DEFAULT false;
ALTER TABLE fighters ADD COLUMN IF NOT EXISTS ranking TEXT;
ALTER TABLE fighters ADD COLUMN IF NOT EXISTS style TEXT;
ALTER TABLE fighters ADD COLUMN IF NOT EXISTS gym TEXT;
ALTER TABLE fighters ADD COLUMN IF NOT EXISTS head_coach TEXT;
ALTER TABLE fighters ADD COLUMN IF NOT EXISTS fighting_out_of TEXT;
ALTER TABLE fighters ADD COLUMN IF NOT EXISTS record_nc INT DEFAULT 0;
ALTER TABLE fighters ADD COLUMN IF NOT EXISTS tko_wins INT DEFAULT 0;
ALTER TABLE fighters ADD COLUMN IF NOT EXISTS losses_by_ko INT DEFAULT 0;
ALTER TABLE fighters ADD COLUMN IF NOT EXISTS losses_by_sub INT DEFAULT 0;
ALTER TABLE fighters ADD COLUMN IF NOT EXISTS losses_by_dec INT DEFAULT 0;
ALTER TABLE fighters ADD COLUMN IF NOT EXISTS finish_rate NUMERIC;
ALTER TABLE fighters ADD COLUMN IF NOT EXISTS longest_win_streak INT DEFAULT 0;
ALTER TABLE fighters ADD COLUMN IF NOT EXISTS slpm NUMERIC;
ALTER TABLE fighters ADD COLUMN IF NOT EXISTS sapm NUMERIC;
ALTER TABLE fighters ADD COLUMN IF NOT EXISTS strike_accuracy NUMERIC;
ALTER TABLE fighters ADD COLUMN IF NOT EXISTS strike_defense NUMERIC;
ALTER TABLE fighters ADD COLUMN IF NOT EXISTS takedown_avg NUMERIC;
ALTER TABLE fighters ADD COLUMN IF NOT EXISTS takedown_accuracy NUMERIC;
ALTER TABLE fighters ADD COLUMN IF NOT EXISTS takedown_defense NUMERIC;
ALTER TABLE fighters ADD COLUMN IF NOT EXISTS sub_avg NUMERIC;
ALTER TABLE fighters ADD COLUMN IF NOT EXISTS body_image_url TEXT;
ALTER TABLE fighters ADD COLUMN IF NOT EXISTS website_url TEXT;

-- ── fight_history ─────────────────────────────────────────────────────────────

ALTER TABLE fight_history ADD COLUMN IF NOT EXISTS method_detail TEXT;
ALTER TABLE fight_history ADD COLUMN IF NOT EXISTS rounds_scheduled INT;
ALTER TABLE fight_history ADD COLUMN IF NOT EXISTS title_fight BOOLEAN DEFAULT false;
ALTER TABLE fight_history ADD COLUMN IF NOT EXISTS fight_type TEXT;
ALTER TABLE fight_history ADD COLUMN IF NOT EXISTS fight_date DATE;
ALTER TABLE fight_history ADD COLUMN IF NOT EXISTS event_date DATE;
ALTER TABLE fight_history ADD COLUMN IF NOT EXISTS event_promotion TEXT;
ALTER TABLE fight_history ADD COLUMN IF NOT EXISTS weight_class TEXT;
ALTER TABLE fight_history ADD COLUMN IF NOT EXISTS billing TEXT;
ALTER TABLE fight_history ADD COLUMN IF NOT EXISTS bout_order INT;
ALTER TABLE fight_history ADD COLUMN IF NOT EXISTS location JSONB;

-- ── events ───────────────────────────────────────────────────────────────────

ALTER TABLE events ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS state TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS country TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS lock_time TIMESTAMP WITH TIME ZONE;
ALTER TABLE events ADD COLUMN IF NOT EXISTS poster_url TEXT;

-- ── event_fights ──────────────────────────────────────────────────────────────

ALTER TABLE event_fights ADD COLUMN IF NOT EXISTS bout_order INT;
ALTER TABLE event_fights ADD COLUMN IF NOT EXISTS is_title_fight BOOLEAN DEFAULT false;
ALTER TABLE event_fights ADD COLUMN IF NOT EXISTS rounds_scheduled INT;

-- ── news_articles ─────────────────────────────────────────────────────────────

ALTER TABLE news_articles ADD COLUMN IF NOT EXISTS fighter_reference_id UUID REFERENCES fighters(id) ON DELETE SET NULL;
ALTER TABLE news_articles ADD COLUMN IF NOT EXISTS event_reference_id UUID REFERENCES events(id) ON DELETE SET NULL;

-- ── pipeline_jobs ─────────────────────────────────────────────────────────────

ALTER TABLE pipeline_jobs ADD COLUMN IF NOT EXISTS event_id UUID REFERENCES events(id) ON DELETE SET NULL;
