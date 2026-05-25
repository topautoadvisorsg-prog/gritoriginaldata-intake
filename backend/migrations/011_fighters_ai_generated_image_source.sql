-- Migration 011: Add ai_generated and image_source columns to fighters table
-- Agent 7 sets ai_generated=TRUE when body shot is DALL-E 3 generated.
-- image_source tracks the origin of the headshot (sherdog, manual, etc).
-- Run this in your Supabase SQL Editor.

ALTER TABLE fighters ADD COLUMN IF NOT EXISTS ai_generated BOOLEAN DEFAULT FALSE;
ALTER TABLE fighters ADD COLUMN IF NOT EXISTS image_source TEXT DEFAULT NULL;

COMMENT ON COLUMN fighters.ai_generated IS 'TRUE when body_image_url was produced by DALL-E 3';
COMMENT ON COLUMN fighters.image_source IS 'Origin of image_url: sherdog, manual, generated, etc.';
