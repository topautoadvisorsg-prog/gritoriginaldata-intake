-- Migration 006: Create odds table
-- Run this in your Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS odds (
    id              UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    fight_card_id   TEXT,
    fighter1_ml     TEXT,
    fighter2_ml     TEXT,
    over_under      TEXT,
    method_ko_tko   TEXT,
    method_submission TEXT,
    method_decision TEXT,
    source          TEXT,
    status          TEXT        NOT NULL DEFAULT 'staging',
    pulled_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for common lookups
CREATE INDEX IF NOT EXISTS odds_fight_card_id_idx ON odds (fight_card_id);
CREATE INDEX IF NOT EXISTS odds_status_idx        ON odds (status);
CREATE INDEX IF NOT EXISTS odds_pulled_at_idx     ON odds (pulled_at DESC);

-- RLS: service role can read/write; anon can read approved rows
ALTER TABLE odds ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "service_role_all_odds"
    ON odds FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY IF NOT EXISTS "anon_read_approved_odds"
    ON odds FOR SELECT TO anon USING (status = 'approved');
