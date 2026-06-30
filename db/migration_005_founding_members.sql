-- Migration 005 — Founding members
-- Locks the first 100 conference_2026 signups into the $49/month founding rate for life.
--
-- Run once in Railway query console (or psql $DATABASE_URL):
--   psql $DATABASE_URL < db/migration_005_founding_members.sql

-- Columns
ALTER TABLE waitlist
  ADD COLUMN IF NOT EXISTS founding_member BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS founding_number INTEGER;

-- Only one row can hold each founding number (1..100). Safety net against races.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_waitlist_founding_number
  ON waitlist (founding_number)
  WHERE founding_number IS NOT NULL;

-- Fast lookups for the public counter and Sean's activation queries.
CREATE INDEX IF NOT EXISTS idx_waitlist_conference_founding
  ON waitlist (source, founding_member)
  WHERE source = 'conference_2026';

-- Backfill: any conference_2026 rows that already exist (test signups from the
-- 2026-05-13 launch) get founding numbers in chronological order.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (ORDER BY created_at, id) AS rn
  FROM waitlist
  WHERE source = 'conference_2026'
    AND founding_member = FALSE
)
UPDATE waitlist w
SET founding_member = TRUE,
    founding_number = ranked.rn
FROM ranked
WHERE w.id = ranked.id
  AND ranked.rn <= 100;
