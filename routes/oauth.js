const express = require("express");
const crypto = require("crypto");
// fetch is available globally in Node 18+ — no import needed
const db = require("../db");
const requireAuth = require("../middleware/requireAuth");
const requireSubscription = require("../middleware/requireSubscription");

const router = express.Router();

// ── PKCE store for Twitter OAuth (in-memory, 10-min TTL) ─────────────────────
const pkceStore = new Map();

function generatePKCE() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

// Clean up expired entries every 15 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of pkceStore.entries()) {
    if (val.expires < now) pkceStore.delete(key);
  }
}, 15 * 60 * 1000);

// ── GET /oauth/connections ─────────────────────────────────────────────────────
// Returns which platforms the current user has connected.
// Public-facing check — requires auth but NOT subscription (so users can connect
// before their trial starts).
router.get("/connections", requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT platform, meta_user_id, linkedin_urn, token_expires_at
       FROM oauth_tokens WHERE user_id = $1`,
      [req.user.id]
    );
    const result = {
      meta: null,
      linkedin: null,
      twitter: null,
      pinterest: null,
    };
    for (const row of rows) {
      if (row.platform === "meta") {
        result.meta = { connected: true, metaUserId: row.meta_user_id };
      } else if (row.platform === "linkedin") {
        result.linkedin = { connected: true, linkedinUrn: row.linkedin_urn };
      } else if (row.platform === "twitter") {
        result.twitter = { connected: true, username: row.twitter_username };
      } else if (row.platform === "pinterest") {
        result.pinterest = { connected: true, username: row.pinterest_username };
      }
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ── OAuth URL generators — auth only, no subscription required ────────────────
// These let users connect their accounts before or without an active subscription.
// Actual posting/scheduling is still gated behind requireSubscription.

// GET /oauth/meta/url
router.get("/meta/url", requireAuth, (req, res) => {
  const state = Buffer.from(JSON.stringify({ user_id: req.user.id })).toString("base64url");
  const url = new URL("https://www.facebook.com/v20.0/dialog/oauth");
  url.searchParams.set("client_id", process.env.META_APP_ID);
  url.searchParams.set("redirect_uri", process.env.META_REDIRECT_URI);
  url.searchParams.set("scope", [
    "public_profile", "email", "pages_show_list", "pages_read_engagement",
    "pages_manage_posts", "instagram_basic", "instagram_content_publish",
  ].join(","));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  res.json({ url: url.toString() });
});

// GET /oauth/linkedin/url
router.get("/linkedin/url", requireAuth, (req, res) => {
  const state = Buffer.from(JSON.stringify({ user_id: req.user.id })).toString("base64url");
  const url = new URL("https://www.linkedin.com/oauth/v2/authorization");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", process.env.LINKEDIN_CLIENT_ID);
  url.searchParams.set("redirect_uri", process.env.LINKEDIN_REDIRECT_URI);
  url.searchParams.set("scope", "openid profile email w_member_social");
  url.searchParams.set("state", state);
  res.json({ url: url.toString() });
});

// GET /oauth/twitter/url
router.get("/twitter/url", requireAuth, (req, res) => {
  const { verifier, challenge } = generatePKCE();
  const state = crypto.randomBytes(16).toString("base64url");
  pkceStore.set(state, { verifier, user_id: req.user.id, expires: Date.now() + 10 * 60 * 1000 });
  const url = new URL("https://twitter.com/i/oauth2/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", process.env.TWITTER_CLIENT_ID);
  url.searchParams.set("redirect_uri", process.env.TWITTER_REDIRECT_URI);
  url.searchParams.set("scope", "tweet.read tweet.write users.read offline.access");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  res.json({ url: url.toString() });
});

// GET /oauth/pinterest/url
router.get("/pinterest/url", requireAuth, (req, res) => {
  const state = Buffer.from(JSON.stringify({ user_id: req.user.id })).toString("base64url");
  const url = new URL("https://www.pinterest.com/oauth/");
  url.searchParams.set("client_id", process.env.PINTEREST_APP_ID);
  url.searchParams.set("redirect_uri", process.env.PINTEREST_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "boards:read,boards:write,pins:read,pins:write,user_accounts:read");
  url.searchParams.set("state", state);
  res.json({ url: url.toString() });
});

// ── OAuth callbacks are PUBLIC — called by Facebook/LinkedIn redirect, no JWT ──

// GET /oauth/meta/callback
router.get("/meta/callback", async (req, res, next) => {
  try {
    const { code, state, error } = req.query;

    if (error) {
      return res.redirect(`postkraft://oauth/meta/error?message=${encodeURIComponent(error)}`);
    }

    let user_id;
    try {
      ({ user_id } = JSON.parse(Buffer.from(state, "base64url").toString()));
    } catch {
      return res.status(400).json({ error: "Invalid state parameter" });
    }

    const tokenRes = await fetch(
      `https://graph.facebook.com/v20.0/oauth/access_token?` +
        new URLSearchParams({
          client_id: process.env.META_APP_ID,
          client_secret: process.env.META_APP_SECRET,
          redirect_uri: process.env.META_REDIRECT_URI,
          code,
        })
    );
    const tokenData = await tokenRes.json();
    if (tokenData.error) throw new Error(tokenData.error.message);

    const longLivedRes = await fetch(
      `https://graph.facebook.com/v20.0/oauth/access_token?` +
        new URLSearchParams({
          grant_type: "fb_exchange_token",
          client_id: process.env.META_APP_ID,
          client_secret: process.env.META_APP_SECRET,
          fb_exchange_token: tokenData.access_token,
        })
    );
    const longLived = await longLivedRes.json();
    if (longLived.error) throw new Error(longLived.error.message);

    const meRes = await fetch(
      `https://graph.facebook.com/v20.0/me?fields=id,name&access_token=${longLived.access_token}`
    );
    const me = await meRes.json();

    const expiresAt = longLived.expires_in
      ? new Date(Date.now() + longLived.expires_in * 1000)
      : null;

    await db.query(
      `INSERT INTO oauth_tokens (user_id, platform, access_token, token_expires_at, meta_user_id)
       VALUES ($1, 'meta', $2, $3, $4)
       ON CONFLICT (user_id, platform) DO UPDATE SET
         access_token     = EXCLUDED.access_token,
         token_expires_at = EXCLUDED.token_expires_at,
         meta_user_id     = EXCLUDED.meta_user_id,
         updated_at       = NOW()`,
      [user_id, longLived.access_token, expiresAt, me.id]
    );

    res.redirect(`postkraft://oauth/meta/success`);
  } catch (err) {
    next(err);
  }
});

// GET /oauth/linkedin/callback
router.get("/linkedin/callback", async (req, res, next) => {
  try {
    const { code, state, error } = req.query;

    if (error) {
      return res.redirect(`postkraft://oauth/linkedin/error?message=${encodeURIComponent(error)}`);
    }

    let user_id;
    try {
      ({ user_id } = JSON.parse(Buffer.from(state, "base64url").toString()));
    } catch {
      return res.status(400).json({ error: "Invalid state parameter" });
    }

    const tokenRes = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: process.env.LINKEDIN_REDIRECT_URI,
        client_id: process.env.LINKEDIN_CLIENT_ID,
        client_secret: process.env.LINKEDIN_CLIENT_SECRET,
      }),
    });
    const tokenData = await tokenRes.json();
    if (tokenData.error) throw new Error(tokenData.error_description || tokenData.error);

    const profileRes = await fetch("https://api.linkedin.com/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const profile = await profileRes.json();

    const expiresAt = tokenData.expires_in
      ? new Date(Date.now() + tokenData.expires_in * 1000)
      : null;

    await db.query(
      `INSERT INTO oauth_tokens (user_id, platform, access_token, token_expires_at, linkedin_urn)
       VALUES ($1, 'linkedin', $2, $3, $4)
       ON CONFLICT (user_id, platform) DO UPDATE SET
         access_token     = EXCLUDED.access_token,
         token_expires_at = EXCLUDED.token_expires_at,
         linkedin_urn     = EXCLUDED.linkedin_urn,
         updated_at       = NOW()`,
      [user_id, tokenData.access_token, expiresAt, profile.sub]
    );

    res.redirect(`postkraft://oauth/linkedin/success`);
  } catch (err) {
    next(err);
  }
});

// ── TWITTER callback (public) ─────────────────────────────────────────────────
router.get("/twitter/callback", async (req, res, next) => {
  try {
    const { code, state, error } = req.query;

    if (error) {
      return res.redirect(`postkraft://oauth/twitter/error?message=${encodeURIComponent(error)}`);
    }

    const pkce = pkceStore.get(state);
    if (!pkce || pkce.expires < Date.now()) {
      return res.redirect(`postkraft://oauth/twitter/error?message=Session+expired`);
    }
    pkceStore.delete(state);

    const tokenRes = await fetch("https://api.twitter.com/2/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(
          `${process.env.TWITTER_CLIENT_ID}:${process.env.TWITTER_CLIENT_SECRET}`
        ).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: process.env.TWITTER_REDIRECT_URI,
        code_verifier: pkce.verifier,
      }),
    });
    const tokenData = await tokenRes.json();
    if (tokenData.error) throw new Error(tokenData.error_description || tokenData.error);

    // Fetch Twitter user info
    const meRes = await fetch("https://api.twitter.com/2/users/me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const me = await meRes.json();
    const twitterUserId = me.data?.id;
    const twitterUsername = me.data?.username;

    const expiresAt = tokenData.expires_in
      ? new Date(Date.now() + tokenData.expires_in * 1000)
      : null;

    await db.query(
      `INSERT INTO oauth_tokens
         (user_id, platform, access_token, refresh_token, token_expires_at, twitter_user_id, twitter_username)
       VALUES ($1, 'twitter', $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, platform) DO UPDATE SET
         access_token      = EXCLUDED.access_token,
         refresh_token     = EXCLUDED.refresh_token,
         token_expires_at  = EXCLUDED.token_expires_at,
         twitter_user_id   = EXCLUDED.twitter_user_id,
         twitter_username  = EXCLUDED.twitter_username,
         updated_at        = NOW()`,
      [pkce.user_id, tokenData.access_token, tokenData.refresh_token ?? null, expiresAt, twitterUserId, twitterUsername]
    );

    res.redirect(`postkraft://oauth/twitter/success`);
  } catch (err) {
    next(err);
  }
});

// ── PINTEREST callback (public) ───────────────────────────────────────────────
router.get("/pinterest/callback", async (req, res, next) => {
  try {
    const { code, state, error } = req.query;

    if (error) {
      return res.redirect(`postkraft://oauth/pinterest/error?message=${encodeURIComponent(error)}`);
    }

    let user_id;
    try {
      ({ user_id } = JSON.parse(Buffer.from(state, "base64url").toString()));
    } catch {
      return res.status(400).json({ error: "Invalid state parameter" });
    }

    const tokenRes = await fetch("https://api.pinterest.com/v5/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(
          `${process.env.PINTEREST_APP_ID}:${process.env.PINTEREST_APP_SECRET}`
        ).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: process.env.PINTEREST_REDIRECT_URI,
      }),
    });
    const tokenData = await tokenRes.json();
    if (tokenData.status === "failure") throw new Error(tokenData.message || "Pinterest token exchange failed");

    // Fetch user info
    const meRes = await fetch("https://api.pinterest.com/v5/user_account", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const me = await meRes.json();
    const pinterestUserId = me.id;
    const pinterestUsername = me.username;

    const expiresAt = tokenData.expires_in
      ? new Date(Date.now() + tokenData.expires_in * 1000)
      : null;

    await db.query(
      `INSERT INTO oauth_tokens
         (user_id, platform, access_token, refresh_token, token_expires_at, pinterest_user_id, pinterest_username)
       VALUES ($1, 'pinterest', $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, platform) DO UPDATE SET
         access_token        = EXCLUDED.access_token,
         refresh_token       = EXCLUDED.refresh_token,
         token_expires_at    = EXCLUDED.token_expires_at,
         pinterest_user_id   = EXCLUDED.pinterest_user_id,
         pinterest_username  = EXCLUDED.pinterest_username,
         updated_at          = NOW()`,
      [user_id, tokenData.access_token, tokenData.refresh_token ?? null, expiresAt, pinterestUserId, pinterestUsername]
    );

    res.redirect(`postkraft://oauth/pinterest/success`);
  } catch (err) {
    next(err);
  }
});

// All other OAuth routes require auth + active subscription
router.use(requireAuth, requireSubscription);

// ══════════════════════════════════════════════════════════════════════════════
//  META (Facebook / Instagram)
// ══════════════════════════════════════════════════════════════════════════════

const META_SCOPES = [
  "public_profile",
  "email",
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
  "instagram_basic",
  "instagram_content_publish",
].join(",");

// GET /oauth/meta/start
// Redirects the user's browser to Facebook OAuth consent screen.
router.get("/meta/start", (req, res) => {
  // Embed user ID in state param so we know who to save the token for after callback
  const state = Buffer.from(JSON.stringify({ user_id: req.user.id })).toString("base64url");

  const url = new URL("https://www.facebook.com/v20.0/dialog/oauth");
  url.searchParams.set("client_id", process.env.META_APP_ID);
  url.searchParams.set("redirect_uri", process.env.META_REDIRECT_URI);
  url.searchParams.set("scope", META_SCOPES);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);

  res.redirect(url.toString());
});


// GET /oauth/meta/token
// Electron calls this to get the stored Meta token for the current user.
router.get("/meta/token", async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT access_token, meta_user_id, meta_page_id, token_expires_at
       FROM oauth_tokens WHERE user_id = $1 AND platform = 'meta'`,
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Not connected" });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /oauth/meta/disconnect
router.delete("/meta/disconnect", async (req, res, next) => {
  try {
    await db.query(
      "DELETE FROM oauth_tokens WHERE user_id = $1 AND platform = 'meta'",
      [req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  LINKEDIN
// ══════════════════════════════════════════════════════════════════════════════

const LINKEDIN_SCOPES = "openid profile email w_member_social";

// GET /oauth/linkedin/start
router.get("/linkedin/start", (req, res) => {
  const state = Buffer.from(JSON.stringify({ user_id: req.user.id })).toString("base64url");

  const url = new URL("https://www.linkedin.com/oauth/v2/authorization");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", process.env.LINKEDIN_CLIENT_ID);
  url.searchParams.set("redirect_uri", process.env.LINKEDIN_REDIRECT_URI);
  url.searchParams.set("scope", LINKEDIN_SCOPES);
  url.searchParams.set("state", state);

  res.redirect(url.toString());
});


// GET /oauth/linkedin/token
router.get("/linkedin/token", async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT access_token, linkedin_urn, token_expires_at
       FROM oauth_tokens WHERE user_id = $1 AND platform = 'linkedin'`,
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Not connected" });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /oauth/linkedin/disconnect
router.delete("/linkedin/disconnect", async (req, res, next) => {
  try {
    await db.query(
      "DELETE FROM oauth_tokens WHERE user_id = $1 AND platform = 'linkedin'",
      [req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  TWITTER
// ══════════════════════════════════════════════════════════════════════════════

const TWITTER_SCOPES = "tweet.read tweet.write users.read offline.access";

// DELETE /oauth/twitter/disconnect
router.delete("/twitter/disconnect", async (req, res, next) => {
  try {
    await db.query(
      "DELETE FROM oauth_tokens WHERE user_id = $1 AND platform = 'twitter'",
      [req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  PINTEREST
// ══════════════════════════════════════════════════════════════════════════════

const PINTEREST_SCOPES = "boards:read,boards:write,pins:read,pins:write,user_accounts:read";

// GET /oauth/pinterest/boards
// Returns the user's Pinterest boards. Used by Studio to populate the
// board picker dropdown when creating a Pin.
router.get("/pinterest/boards", async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT access_token FROM oauth_tokens
       WHERE user_id = $1 AND platform = 'pinterest'`,
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Pinterest not connected" });

    const boardsRes = await fetch(
      "https://api.pinterest.com/v5/boards?page_size=100",
      { headers: { Authorization: `Bearer ${rows[0].access_token}` } }
    );

    if (!boardsRes.ok) {
      const errText = await boardsRes.text();
      throw new Error(`Pinterest boards fetch failed (${boardsRes.status}): ${errText}`);
    }

    const data = await boardsRes.json();
    // Pinterest returns { items: [{id, name, ...}], bookmark }
    // Surface just what the frontend needs
    res.json({
      boards: (data.items || []).map((b) => ({
        id: b.id,
        name: b.name,
        privacy: b.privacy,
        pinCount: b.pin_count,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /oauth/pinterest/disconnect
router.delete("/pinterest/disconnect", async (req, res, next) => {
  try {
    await db.query(
      "DELETE FROM oauth_tokens WHERE user_id = $1 AND platform = 'pinterest'",
      [req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
