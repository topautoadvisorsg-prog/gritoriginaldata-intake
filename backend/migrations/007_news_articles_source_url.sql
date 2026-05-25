-- Migration 007: Create/align news_articles table with pipeline spec
-- Safe to run multiple times (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
-- Run this in your Supabase SQL Editor.

-- Ensure the table exists with all base columns
CREATE TABLE IF NOT EXISTS news_articles (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fighter_id   UUID REFERENCES fighters(id) ON DELETE SET NULL,
    headline     TEXT,
    summary      TEXT,
    source_url   TEXT,
    layer        TEXT DEFAULT 'standard',
    signal_type  TEXT,
    topic_tags   TEXT[],
    author       TEXT,
    published_at TIMESTAMPTZ,
    is_published BOOLEAN DEFAULT false,
    admin_status TEXT DEFAULT 'pending',
    reviewed_at  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ DEFAULT now()
);

-- Add spec-required columns if table already existed without them
ALTER TABLE news_articles ADD COLUMN IF NOT EXISTS fighter_id   UUID REFERENCES fighters(id) ON DELETE SET NULL;
ALTER TABLE news_articles ADD COLUMN IF NOT EXISTS headline     TEXT;
ALTER TABLE news_articles ADD COLUMN IF NOT EXISTS summary      TEXT;
ALTER TABLE news_articles ADD COLUMN IF NOT EXISTS source_url   TEXT;
ALTER TABLE news_articles ADD COLUMN IF NOT EXISTS layer        TEXT DEFAULT 'standard';
ALTER TABLE news_articles ADD COLUMN IF NOT EXISTS signal_type  TEXT;
ALTER TABLE news_articles ADD COLUMN IF NOT EXISTS topic_tags   TEXT[];
ALTER TABLE news_articles ADD COLUMN IF NOT EXISTS admin_status TEXT DEFAULT 'pending';
ALTER TABLE news_articles ADD COLUMN IF NOT EXISTS is_published BOOLEAN DEFAULT false;
ALTER TABLE news_articles ADD COLUMN IF NOT EXISTS reviewed_at  TIMESTAMPTZ;

-- Back-fill headline from title for any pre-migration rows
UPDATE news_articles SET headline = title WHERE headline IS NULL AND title IS NOT NULL;
UPDATE news_articles SET summary  = content WHERE summary IS NULL AND content IS NOT NULL;

-- Indexes
CREATE INDEX IF NOT EXISTS news_articles_fighter_id_idx    ON news_articles (fighter_id);
CREATE INDEX IF NOT EXISTS news_articles_admin_status_idx  ON news_articles (admin_status);
CREATE INDEX IF NOT EXISTS news_articles_published_at_idx  ON news_articles (published_at DESC);
CREATE INDEX IF NOT EXISTS news_articles_source_url_idx    ON news_articles (source_url);
CREATE INDEX IF NOT EXISTS news_articles_layer_idx         ON news_articles (layer);

-- Disable RLS (pipeline writes via service key)
ALTER TABLE news_articles DISABLE ROW LEVEL SECURITY;
