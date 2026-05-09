-- PostKraft SaaS — Postgres Schema
-- Run once on a fresh database:
--   psql $DATABASE_URL < db/schema.sql
-- Or paste into Railway's query console.

-- ─── Users ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email               TEXT UNIQUE NOT NULL,
  password_hash       TEXT NOT NULL,
  full_name           TEXT,
  -- Stripe
  stripe_customer_id  TEXT UNIQUE,
  subscription_status TEXT NOT NULL DEFAULT 'inactive',
    -- inactive | trialing | active | past_due | canceled
  subscription_id     TEXT,
  trial_ends_at       TIMESTAMPTZ,
  current_period_end  TIMESTAMPTZ,
  -- Timestamps
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── OAuth tokens (per user, per platform) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS oauth_tokens (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform        TEXT NOT NULL,  -- 'meta' | 'linkedin'
  access_token    TEXT NOT NULL,
  refresh_token   TEXT,
  token_expires_at TIMESTAMPTZ,
  -- Meta-specific: may have multiple pages/accounts
  meta_user_id    TEXT,
  meta_page_id    TEXT,
  meta_page_name  TEXT,
  -- LinkedIn-specific
  linkedin_urn    TEXT,
  -- Timestamps
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, platform)
);

-- ─── Scheduled posts (server-side, fires even when Mac is off) ───────────────
CREATE TABLE IF NOT EXISTS scheduled_posts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform        TEXT NOT NULL,
  caption         TEXT NOT NULL,
  hashtags        TEXT,
  cta             TEXT,
  image_url       TEXT,
  scheduled_at    TIMESTAMPTZ NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
    -- pending | sent | failed | canceled
  error           TEXT,
  sent_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Indexes ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user_platform ON oauth_tokens(user_id, platform);
CREATE INDEX IF NOT EXISTS idx_scheduled_posts_user ON scheduled_posts(user_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_posts_pending ON scheduled_posts(status, scheduled_at)
  WHERE status = 'pending';

-- ─── Auto-update updated_at ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER users_updated_at
  BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER oauth_tokens_updated_at
  BEFORE UPDATE ON oauth_tokens FOR EACH ROW EXECUTE FUNCTION update_updated_at();
