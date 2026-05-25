-- Supabase Schema for MMA Data Ingestion Pipeline
-- Aligned with GRIT platform v2.0
-- Source of truth — run database/migrations/ files for incremental changes

-- 1. Fighters Table
CREATE TABLE IF NOT EXISTS fighters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Identity
    name TEXT NOT NULL,
    nickname TEXT,
    gender TEXT,
    nationality TEXT,
    dob DATE,
    organization TEXT,

    -- Physical
    weight_class TEXT,
    height_cm NUMERIC,
    reach_cm NUMERIC,
    leg_reach_cm NUMERIC,
    stance TEXT,

    -- Career
    status TEXT DEFAULT 'active',              -- active, inactive, retired
    is_active BOOLEAN DEFAULT true,
    is_champion BOOLEAN DEFAULT false,
    ranking TEXT,
    style TEXT,
    gym TEXT,                                   -- canonical gym/team field (GRIT spec)
    team TEXT,                                  -- legacy alias kept for backwards compat
    head_coach TEXT,
    fighting_out_of TEXT,

    -- Record
    record_wins INT DEFAULT 0,
    record_losses INT DEFAULT 0,
    record_draws INT DEFAULT 0,
    record_nc INT DEFAULT 0,

    -- Performance — method wins
    ko_wins INT DEFAULT 0,
    tko_wins INT DEFAULT 0,
    sub_wins INT DEFAULT 0,
    dec_wins INT DEFAULT 0,

    -- Performance — method losses
    losses_by_ko INT DEFAULT 0,
    losses_by_sub INT DEFAULT 0,
    losses_by_dec INT DEFAULT 0,

    -- Performance — derived stats
    finish_rate NUMERIC,                        -- wins / total_fights
    longest_win_streak INT DEFAULT 0,

    -- Performance — striking
    slpm NUMERIC,                               -- strikes landed per minute
    sapm NUMERIC,                               -- strikes absorbed per minute
    strike_accuracy NUMERIC,
    strike_defense NUMERIC,

    -- Performance — grappling
    takedown_avg NUMERIC,
    takedown_accuracy NUMERIC,
    takedown_defense NUMERIC,
    sub_avg NUMERIC,

    -- Images
    image_url TEXT,
    body_image_url TEXT,
    needs_image BOOLEAN DEFAULT false,
    ai_generated BOOLEAN DEFAULT false,

    -- Social
    twitter_handle TEXT,
    instagram_handle TEXT,
    website_url TEXT,

    -- Pipeline metadata
    verified BOOLEAN DEFAULT false,
    review_notes JSONB,
    ai_brief JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- 2. Fight History Table
CREATE TABLE IF NOT EXISTS fight_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Participants
    fighter_id UUID REFERENCES fighters(id) ON DELETE CASCADE,
    opponent_name TEXT,
    opponent_id UUID REFERENCES fighters(id) ON DELETE SET NULL,

    -- Result
    result TEXT,
    method TEXT,
    method_detail TEXT,
    round INT,
    time TEXT,
    rounds_scheduled INT,
    title_fight BOOLEAN DEFAULT false,
    fight_type TEXT,                            -- "Bout", "Title Bout", "Interim Title Bout"

    -- Event snapshot
    event_name TEXT,
    fight_date DATE,                            -- date of this specific fight (agent-facing column)
    event_date DATE,                            -- alias snapshot from event record
    event_promotion TEXT,

    -- Card info
    weight_class TEXT,
    billing TEXT,                               -- "Main Event", "Co-Main Event", "Prelim"
    bout_order INT,
    referee TEXT,

    -- Location
    location JSONB,                             -- { city, state, country, venue }

    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- 3. Events Table
CREATE TABLE IF NOT EXISTS events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_name TEXT NOT NULL,
    promotion TEXT,
    event_date DATE,
    venue TEXT,
    city TEXT,
    state TEXT,
    country TEXT,
    lock_time TIMESTAMP WITH TIME ZONE,
    poster_url TEXT,
    status TEXT DEFAULT 'Upcoming',             -- Upcoming, Live, Completed, Closed, Archived
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- 4. Event Fights Table (Bouts on a card)
CREATE TABLE IF NOT EXISTS event_fights (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id UUID REFERENCES events(id) ON DELETE CASCADE,
    fighter_a_id UUID REFERENCES fighters(id),
    fighter_b_id UUID REFERENCES fighters(id),
    weight_class TEXT,
    card_position INT,
    bout_order INT,
    is_title_fight BOOLEAN DEFAULT false,
    rounds_scheduled INT,
    result_logged BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- 5. News Articles Table (Aligned with GRIT news_articles)
CREATE TABLE IF NOT EXISTS news_articles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    headline TEXT NOT NULL,
    summary TEXT,
    content TEXT,
    source_url TEXT,
    image_url TEXT,
    layer TEXT DEFAULT 'standard',              -- standard, intelligence
    signal_type TEXT,                           -- injury, camp-change, behavior, weight, silence, deleted-post
    topic_tags TEXT[],
    entity_tags TEXT[],
    content_tags TEXT[],
    seo_slug TEXT,
    published_at TIMESTAMP WITH TIME ZONE,
    fighter_reference_id UUID REFERENCES fighters(id) ON DELETE SET NULL,
    event_reference_id UUID REFERENCES events(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- 6. Pipeline Jobs (Ingestion Tracking)
CREATE TABLE IF NOT EXISTS pipeline_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fighter_name TEXT,
    fighter_id UUID REFERENCES fighters(id) ON DELETE SET NULL,
    event_id UUID REFERENCES events(id) ON DELETE SET NULL,
    status TEXT DEFAULT 'queued',               -- queued, profiling, history, complete, failed
    error_log TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- 7. Config Table (Agent Settings)
CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- 8. Monitored Accounts (Agent 5)
CREATE TABLE IF NOT EXISTS monitored_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fighter_id UUID REFERENCES fighters(id) ON DELETE CASCADE,
    platform TEXT,                              -- twitter, instagram
    handle TEXT,
    last_scanned TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- 9. Odds Table (Agent 6)
CREATE TABLE IF NOT EXISTS odds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fight_card_id UUID REFERENCES event_fights(id) ON DELETE CASCADE,
    fighter_a_line TEXT,
    fighter_b_line TEXT,
    method_ko_tko TEXT,
    method_submission TEXT,
    method_decision TEXT,
    round_betting TEXT,
    source TEXT,
    status TEXT DEFAULT 'staging',              -- staging, approved, rejected, live
    pulled_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Triggers for updated_at

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_pipeline_jobs_updated_at
    BEFORE UPDATE ON pipeline_jobs
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_config_updated_at
    BEFORE UPDATE ON config
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
