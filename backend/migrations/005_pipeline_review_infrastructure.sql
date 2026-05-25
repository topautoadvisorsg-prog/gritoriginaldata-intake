-- Migration 005: Pipeline Review Infrastructure
-- Adds admin review status tracking to fighters, news_articles, and fight_history.
-- Creates the activity_log table for pipeline audit trail.
-- All changes are non-destructive (new columns with safe defaults).

-- ── Admin status on fighters ───────────────────────────────────────────────────
-- Values: 'pending' | 'approved' | 'rejected'
-- Default 'pending' — every new fighter enters the review queue automatically.
ALTER TABLE fighters
  ADD COLUMN IF NOT EXISTS admin_status TEXT NOT NULL DEFAULT 'pending';

-- ── Admin status on news_articles ──────────────────────────────────────────────
ALTER TABLE news_articles
  ADD COLUMN IF NOT EXISTS admin_status TEXT NOT NULL DEFAULT 'pending';

-- ── Admin status on fight_history ──────────────────────────────────────────────
ALTER TABLE fight_history
  ADD COLUMN IF NOT EXISTS admin_status TEXT NOT NULL DEFAULT 'pending';

-- ── Review metadata ────────────────────────────────────────────────────────────
-- Stores who reviewed the record and when (nullable — only set after a review action).
ALTER TABLE fighters
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reviewed_by TEXT;

ALTER TABLE news_articles
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reviewed_by TEXT;

-- ── Activity log table ─────────────────────────────────────────────────────────
-- Every significant pipeline action (scrape, push, error, approval) is logged here.
-- The dashboard reads this table to show the live activity feed.
CREATE TABLE IF NOT EXISTS activity_log (
  id           UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_name   TEXT        NOT NULL,            -- 'Agent 1', 'Agent 2', 'Admin', etc.
  action       TEXT        NOT NULL,            -- 'scraped', 'pushed', 'approved', 'rejected', 'error', 'skipped'
  entity_type  TEXT,                            -- 'fighter', 'fight_history', 'news', 'odds', 'event'
  entity_id    TEXT,                            -- UUID or name of the affected record
  entity_name  TEXT,                            -- Human readable name (fighter name, event name)
  status       TEXT        NOT NULL DEFAULT 'success', -- 'success' | 'failed' | 'skipped'
  detail       TEXT,                            -- Optional message or error detail
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for efficient dashboard queries
CREATE INDEX IF NOT EXISTS idx_activity_log_created_at  ON activity_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_log_agent        ON activity_log (agent_name);
CREATE INDEX IF NOT EXISTS idx_activity_log_status       ON activity_log (status);
CREATE INDEX IF NOT EXISTS idx_activity_log_entity_type  ON activity_log (entity_type);

-- Index for fast pending/approved/rejected counts
CREATE INDEX IF NOT EXISTS idx_fighters_admin_status    ON fighters (admin_status);
CREATE INDEX IF NOT EXISTS idx_news_admin_status        ON news_articles (admin_status);
CREATE INDEX IF NOT EXISTS idx_fight_history_admin_status ON fight_history (admin_status);

-- Backfill: fighters already marked is_verified=true → treat as approved
UPDATE fighters SET admin_status = 'approved' WHERE is_verified = true AND admin_status = 'pending';

-- Seed initial activity log entry so the table is never empty for the UI
INSERT INTO activity_log (agent_name, action, entity_type, entity_name, status, detail)
VALUES ('System', 'initialized', NULL, NULL, 'success', 'Pipeline review infrastructure ready (Migration 005)');
