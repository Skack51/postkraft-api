-- Migration 004 — Waitlist
-- Run in Railway query console:
--   Paste this entire file and execute.

CREATE TABLE IF NOT EXISTS waitlist (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email      TEXT NOT NULL,
  source     TEXT NOT NULL DEFAULT 'real_estate',
    -- real_estate | restaurant | retail
  notified   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(email, source)
);

CREATE INDEX IF NOT EXISTS idx_waitlist_source     ON waitlist(source);
CREATE INDEX IF NOT EXISTS idx_waitlist_created_at ON waitlist(created_at DESC);
