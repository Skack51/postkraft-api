-- Migration 006 — Cloud weekly batch generation
-- Adds the tables behind the paid-tier feature: a synced photo pool, weekly
-- batch runs, per-user content preferences, and AI usage metering. Also extends
-- scheduled_posts so a generated draft is just a post that isn't live yet.
--
-- Decisions locked 2026-06-30 (see "[C] PostKraft Cloud — Installer Flow &
-- Backend Architecture.md"):
--   • AI imagery = branded graphics + real photos (enhancement later, net-new out)
--   • Free/local tier brings its own Anthropic key; paid/cloud tier is metered
--   • Weekly volume = (connected platforms) × posts_per_platform
--
-- Run once in Railway's query console (or psql $DATABASE_URL):
--   psql $DATABASE_URL < db/migration_006_cloud_batch.sql
-- Idempotent — safe to re-run.

-- ─── Photo pool ───────────────────────────────────────────────────────────────
-- Curated photos synced from the customer's Mac up to Cloudinary, so the Sunday
-- batch has material to draw from even when the Mac is off. Rotation is driven by
-- used_count (lowest first) so the same photo doesn't repeat week over week.
CREATE TABLE IF NOT EXISTS photo_pool (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cloudinary_url TEXT NOT NULL,
  source_name    TEXT,                          -- original filename on the Mac
  orientation    TEXT,                          -- portrait | landscape | square
  width          INTEGER,
  height         INTEGER,
  tags           TEXT[] NOT NULL DEFAULT '{}',   -- e.g. {exterior, kitchen, waterfront}
  used_count     INTEGER NOT NULL DEFAULT 0,
  last_used_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_photo_pool_user ON photo_pool(user_id);
-- Rotation query: cheapest-to-reuse photos first, scoped to a user.
CREATE INDEX IF NOT EXISTS idx_photo_pool_rotation ON photo_pool(user_id, used_count, last_used_at);
-- Dedupe: a given Cloudinary image registers once per user. Backs the
-- ON CONFLICT (user_id, cloudinary_url) upsert in POST /photos/sync.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_photo_pool_user_url
  ON photo_pool(user_id, cloudinary_url);

-- ─── Content preferences (one row per user) ──────────────────────────────────
-- The "specific parameters" the wizard collects (Step 6). The weekly cron reads
-- this to decide what to generate and when. Total slots for a run =
-- (number of enabled_platforms) × posts_per_platform.
CREATE TABLE IF NOT EXISTS content_prefs (
  user_id             UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  batch_enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  posts_per_platform  INTEGER NOT NULL DEFAULT 5,   -- per platform, per week
  enabled_platforms   TEXT[] NOT NULL DEFAULT '{}', -- subset of connected platforms to generate for
  -- Per-platform posting schedule, e.g.
  --   {"instagram": ["Mon 09:00","Wed 17:00"], "linkedin": ["Tue 08:00"]}
  -- Times are interpreted in `timezone`.
  posting_schedule    JSONB NOT NULL DEFAULT '{}',
  timezone            TEXT NOT NULL DEFAULT 'America/New_York',
  -- Photo selection rules
  photo_orientations  TEXT[] NOT NULL DEFAULT '{}', -- empty = any
  photo_min_width     INTEGER NOT NULL DEFAULT 0,
  photo_min_height    INTEGER NOT NULL DEFAULT 0,
  photo_recency_days  INTEGER,                       -- NULL = no recency limit
  include_tags        TEXT[] NOT NULL DEFAULT '{}',
  exclude_tags        TEXT[] NOT NULL DEFAULT '{}',
  -- Share of each run that should be branded graphics vs. real photos (0.00–1.00).
  -- 0.30 = ~30% graphic posts (market-stat / Just Listed / quote cards), rest photos.
  graphic_ratio       NUMERIC(3,2) NOT NULL DEFAULT 0.30,
  -- Cost guardrail: max metered AI events per calendar month (NULL = tier default).
  monthly_ai_ceiling  INTEGER,
  -- The agent's voice/profile, synced from the desktop Memory Bank so cloud-side
  -- batch captions sound like them (same content /ai/caption gets in `memory`).
  memory_snapshot     TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Batch runs (one per user per target week) ───────────────────────────────
CREATE TABLE IF NOT EXISTS batch_runs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_of      DATE NOT NULL,                  -- Monday of the target week
  status       TEXT NOT NULL DEFAULT 'generating',
    -- generating | ready | approved | failed
  posts_count  INTEGER NOT NULL DEFAULT 0,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, week_of)                     -- never double-generate a week
);

CREATE INDEX IF NOT EXISTS idx_batch_runs_user ON batch_runs(user_id, week_of);

-- ─── AI usage events (metering for cost control + billing transparency) ──────
CREATE TABLE IF NOT EXISTS usage_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,                 -- caption | image_gen | graphic | web_search
  units         INTEGER NOT NULL DEFAULT 1,
  cost_estimate NUMERIC(10,4),                 -- your $ cost, for margin tracking
  batch_run_id  UUID REFERENCES batch_runs(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Monthly ceiling checks scan per user over a time window.
CREATE INDEX IF NOT EXISTS idx_usage_user_time ON usage_events(user_id, created_at);

-- ─── Extend scheduled_posts ──────────────────────────────────────────────────
-- A generated draft is just a scheduled_post that isn't live yet. status is a
-- free-text column with no CHECK constraint, so 'draft' needs no enum change —
-- and the every-minute scheduler already only fires status='pending', so drafts
-- are ignored until approved (approval flips draft → pending).
ALTER TABLE scheduled_posts
  ADD COLUMN IF NOT EXISTS batch_run_id UUID REFERENCES batch_runs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'manual'; -- manual | weekly_batch

COMMENT ON COLUMN scheduled_posts.status IS
  'pending | sending | sent | failed | canceled | draft  (draft = batch-generated, awaiting review; ignored by scheduler until approved)';
COMMENT ON COLUMN scheduled_posts.origin IS 'manual | weekly_batch';

-- Review queue lookup: a user's drafts for the current batch.
CREATE INDEX IF NOT EXISTS idx_scheduled_posts_drafts
  ON scheduled_posts(user_id, status)
  WHERE status = 'draft';

-- ─── Auto-update updated_at on content_prefs ─────────────────────────────────
-- Reuses the update_updated_at() function defined in db/schema.sql.
CREATE OR REPLACE TRIGGER content_prefs_updated_at
  BEFORE UPDATE ON content_prefs FOR EACH ROW EXECUTE FUNCTION update_updated_at();
