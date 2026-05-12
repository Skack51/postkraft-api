-- Migration 002 — Add Twitter and Pinterest columns to oauth_tokens
-- Run in Railway's query console:
--   Paste this entire file and click Run.

ALTER TABLE oauth_tokens
  ADD COLUMN IF NOT EXISTS twitter_user_id   TEXT,
  ADD COLUMN IF NOT EXISTS twitter_username  TEXT,
  ADD COLUMN IF NOT EXISTS pinterest_user_id TEXT,
  ADD COLUMN IF NOT EXISTS pinterest_username TEXT;

-- Update comment to reflect new platforms
COMMENT ON COLUMN oauth_tokens.platform IS 'meta | linkedin | twitter | pinterest';
