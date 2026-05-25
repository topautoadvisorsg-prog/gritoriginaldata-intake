-- Migration 012: Add verified_at timestamp to fighters table
-- Run this in the Supabase SQL editor to enable verified_at tracking.

ALTER TABLE fighters
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;

-- Backfill: set verified_at = now() for already-verified fighters
UPDATE fighters
SET verified_at = NOW()
WHERE is_verified = TRUE AND verified_at IS NULL;
