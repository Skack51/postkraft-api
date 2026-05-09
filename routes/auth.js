const express = require("express");
const bcrypt = require("bcrypt");
const db = require("../db");
const { signToken } = require("../lib/jwt");
const requireAuth = require("../middleware/requireAuth");

const router = express.Router();
const SALT_ROUNDS = 12;

// ─── POST /auth/register ─────────────────────────────────────────────────────
// Body: { email, password, full_name? }
// Returns: { token, user }
router.post("/register", async (req, res, next) => {
  try {
    const { email, password, full_name } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }

    // Check for existing account
    const existing = await db.query("SELECT id FROM users WHERE email = $1", [
      email.toLowerCase().trim(),
    ]);
    if (existing.rows.length) {
      return res.status(409).json({ error: "An account with that email already exists" });
    }

    const password_hash = await bcrypt.hash(password, SALT_ROUNDS);

    const { rows } = await db.query(
      `INSERT INTO users (email, password_hash, full_name)
       VALUES ($1, $2, $3)
       RETURNING id, email, full_name, subscription_status, created_at`,
      [email.toLowerCase().trim(), password_hash, full_name || null]
    );

    const user = rows[0];
    const token = signToken(user);

    res.status(201).json({ token, user: sanitize(user) });
  } catch (err) {
    next(err);
  }
});

// ─── POST /auth/login ─────────────────────────────────────────────────────────
// Body: { email, password }
// Returns: { token, user }
router.post("/login", async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const { rows } = await db.query(
      `SELECT id, email, full_name, password_hash, subscription_status, current_period_end
       FROM users WHERE email = $1`,
      [email.toLowerCase().trim()]
    );

    const user = rows[0];
    // Use constant-time compare even when user not found to prevent timing attacks
    const match = user
      ? await bcrypt.compare(password, user.password_hash)
      : await bcrypt.compare(password, "$2b$12$invalidhashpadding000000000000000000000000000000000000000");

    if (!user || !match) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const token = signToken(user);
    res.json({ token, user: sanitize(user) });
  } catch (err) {
    next(err);
  }
});

// ─── GET /auth/me ─────────────────────────────────────────────────────────────
// Returns current user info. Useful for Electron app on startup.
router.get("/me", requireAuth, (req, res) => {
  res.json({ user: sanitize(req.user) });
});

// ─── POST /auth/change-password ───────────────────────────────────────────────
// Body: { current_password, new_password }
router.post("/change-password", requireAuth, async (req, res, next) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) {
      return res.status(400).json({ error: "current_password and new_password are required" });
    }
    if (new_password.length < 8) {
      return res.status(400).json({ error: "New password must be at least 8 characters" });
    }

    const { rows } = await db.query("SELECT password_hash FROM users WHERE id = $1", [req.user.id]);
    const match = await bcrypt.compare(current_password, rows[0].password_hash);
    if (!match) {
      return res.status(401).json({ error: "Current password is incorrect" });
    }

    const new_hash = await bcrypt.hash(new_password, SALT_ROUNDS);
    await db.query("UPDATE users SET password_hash = $1 WHERE id = $2", [new_hash, req.user.id]);

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ─── Helper: strip sensitive fields before sending to client ─────────────────
function sanitize(user) {
  const { password_hash, ...safe } = user;
  return safe;
}

module.exports = router;
