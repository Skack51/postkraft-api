const express = require("express");
const fetch = require("node-fetch");
const db = require("../db");
const requireAuth = require("../middleware/requireAuth");
const requireSubscription = require("../middleware/requireSubscription");

const router = express.Router();

// All OAuth routes require a valid, active subscription
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

// GET /oauth/meta/callback
// Facebook redirects here with ?code=... after consent.
router.get("/meta/callback", async (req, res, next) => {
  try {
    const { code, state, error } = req.query;

    if (error) {
      return res.redirect(`postkraft://oauth/meta/error?message=${encodeURIComponent(error)}`);
    }

    // Decode state to get user_id
    let user_id;
    try {
      ({ user_id } = JSON.parse(Buffer.from(state, "base64url").toString()));
    } catch {
      return res.status(400).json({ error: "Invalid state parameter" });
    }

    // Exchange code for short-lived user access token
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

    // Exchange for long-lived token (valid ~60 days)
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

    // Get the user's Meta ID
    const meRes = await fetch(
      `https://graph.facebook.com/v20.0/me?fields=id,name&access_token=${longLived.access_token}`
    );
    const me = await meRes.json();

    const expiresAt = longLived.expires_in
      ? new Date(Date.now() + longLived.expires_in * 1000)
      : null;

    // Upsert token
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

    // Deep-link back to Electron — success
    res.redirect(`postkraft://oauth/meta/success`);
  } catch (err) {
    next(err);
  }
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

    // Exchange code for access token
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

    // Get LinkedIn URN via OpenID Connect userinfo
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

module.exports = router;
