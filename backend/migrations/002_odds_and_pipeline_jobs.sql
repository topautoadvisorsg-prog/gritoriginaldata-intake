-- Migration 002: Create odds and pipeline_jobs tables
-- Run this in the Supabase SQL Editor at: https://supabase.com/dashboard/project/<your-project>/sql

-- ── Odds table ───────────────────────────────────────────────────────────────
-- Stores betting lines scraped by Agent 6 (BestFightOdds)

CREATE TABLE IF NOT EXISTS public.odds (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fight_card_id   UUID REFERENCES public.event_fights(id) ON DELETE SET NULL,
    fighter_a_line  TEXT,
    fighter_b_line  TEXT,
    over_under      TEXT,
    method_ko_tko   TEXT,
    method_submission TEXT,
    method_decision TEXT,
    round_betting   TEXT,
    source          TEXT,
    status          TEXT NOT NULL DEFAULT 'staging'
                        CHECK (status IN ('staging', 'approved', 'rejected')),
    pulled_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS odds_fight_card_id_idx ON public.odds(fight_card_id);
CREATE INDEX IF NOT EXISTS odds_status_idx        ON public.odds(status);
CREATE INDEX IF NOT EXISTS odds_pulled_at_idx     ON public.odds(pulled_at DESC);

-- ── Pipeline jobs table ───────────────────────────────────────────────────────
-- Tracks background pipeline runs for audit and retry purposes

CREATE TABLE IF NOT EXISTS public.pipeline_jobs (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_type     TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'running', 'completed', 'failed')),
    fighter_id   UUID REFERENCES public.fighters(id) ON DELETE SET NULL,
    event_id     UUID REFERENCES public.events(id)   ON DELETE SET NULL,
    error        TEXT,
    metadata     JSONB,
    started_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE,
    updated_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    created_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pipeline_jobs_status_idx     ON public.pipeline_jobs(status);
CREATE INDEX IF NOT EXISTS pipeline_jobs_job_type_idx   ON public.pipeline_jobs(job_type);
CREATE INDEX IF NOT EXISTS pipeline_jobs_updated_at_idx ON public.pipeline_jobs(updated_at DESC);

-- Enable row-level security (optional, mirrors existing tables)
ALTER TABLE public.odds          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pipeline_jobs ENABLE ROW LEVEL SECURITY;

-- Allow full access via service role (used by the data engine backend)
CREATE POLICY IF NOT EXISTS "service_role_all_odds"
    ON public.odds FOR ALL USING (true);

CREATE POLICY IF NOT EXISTS "service_role_all_pipeline_jobs"
    ON public.pipeline_jobs FOR ALL USING (true);
