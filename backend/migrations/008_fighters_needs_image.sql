-- Migration 008: Add needs_image column to fighters
-- Run this in your Supabase SQL Editor.
-- Agent 7 writes needs_image=True/False on every fighter update.
-- Without this column the entire DB update (including image_url + body_image_url) fails silently.

ALTER TABLE fighters ADD COLUMN IF NOT EXISTS needs_image BOOLEAN DEFAULT false;
ALTER TABLE fighters ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS fighters_needs_image_idx ON fighters (needs_image) WHERE needs_image = true;
CREATE INDEX IF NOT EXISTS fighters_admin_status_idx ON fighters (admin_status);
CREATE INDEX IF NOT EXISTS fighters_body_image_null_idx ON fighters (id) WHERE body_image_url IS NULL;
