const express = require("express");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
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

// ─── POST /auth/forgot-password ───────────────────────────────────────────────
// Body: { email }
// Sends a reset email if the account exists. Always returns 200 (no enumeration).
router.post("/forgot-password", async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required" });

    const { rows } = await db.query(
      "SELECT id, email FROM users WHERE email = $1",
      [email.toLowerCase().trim()]
    );

    // Always respond 200 so we don't reveal whether an account exists
    if (!rows.length) return res.json({ success: true });

    const user = rows[0];
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    // Invalidate any existing tokens for this user
    await db.query("DELETE FROM password_reset_tokens WHERE user_id = $1", [user.id]);

    await db.query(
      `INSERT INTO password_reset_tokens (user_id, token, expires_at)
       VALUES ($1, $2, $3)`,
      [user.id, token, expiresAt]
    );

    // Send email via Resend
    const resetUrl = `${process.env.API_BASE_URL || "https://postkraft-api-production.up.railway.app"}/auth/reset-password?token=${token}`;

    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "PostKraft <noreply@postkraft.app>",
        to: [user.email],
        subject: "Reset your PostKraft password",
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px">
            <h2 style="color:#7c3aed;margin-bottom:8px">Reset your password</h2>
            <p style="color:#555;margin-bottom:24px">
              Click the button below to set a new password. This link expires in 1 hour.
            </p>
            <a href="${resetUrl}"
               style="display:inline-block;background:#7c3aed;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">
              Reset Password
            </a>
            <p style="color:#999;font-size:12px;margin-top:24px">
              If you didn't request this, you can safely ignore this email.
            </p>
          </div>
        `,
      }),
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ─── GET /auth/reset-password ─────────────────────────────────────────────────
// Renders a simple HTML form for setting a new password (opened in browser)
router.get("/reset-password", async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send("Invalid reset link.");

  const { rows } = await db.query(
    `SELECT * FROM password_reset_tokens
     WHERE token = $1 AND expires_at > NOW() AND used_at IS NULL`,
    [token]
  );

  if (!rows.length) {
    return res.send(`
      <html><body style="font-family:sans-serif;max-width:480px;margin:80px auto;padding:32px;text-align:center">
        <h2 style="color:#ef4444">Link expired</h2>
        <p>This reset link has expired or already been used. Open PostKraft and request a new one.</p>
      </body></html>
    `);
  }

  res.send(`
    <html><body style="font-family:sans-serif;max-width:480px;margin:80px auto;padding:32px">
      <h2 style="color:#7c3aed;margin-bottom:8px">Set a new password</h2>
      <form method="POST" action="/auth/reset-password">
        <input type="hidden" name="token" value="${token}" />
        <div style="margin-bottom:16px">
          <label style="display:block;margin-bottom:6px;font-size:14px;color:#555">New password</label>
          <input type="password" name="password" required minlength="8"
            style="width:100%;padding:10px;border:1px solid #ddd;border-radius:8px;font-size:14px;box-sizing:border-box" />
        </div>
        <div style="margin-bottom:24px">
          <label style="display:block;margin-bottom:6px;font-size:14px;color:#555">Confirm password</label>
          <input type="password" name="confirm" required minlength="8"
            style="width:100%;padding:10px;border:1px solid #ddd;border-radius:8px;font-size:14px;box-sizing:border-box" />
        </div>
        <button type="submit"
          style="width:100%;background:#7c3aed;color:#fff;padding:12px;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer">
          Set New Password
        </button>
      </form>
    </body></html>
  `);
});

// ─── POST /auth/reset-password ────────────────────────────────────────────────
// Handles form submission from the reset page
router.post("/reset-password", express.urlencoded({ extended: false }), async (req, res, next) => {
  try {
    const { token, password, confirm } = req.body;

    if (!token || !password) return res.status(400).send("Missing fields.");
    if (password !== confirm) return res.status(400).send(`
      <html><body style="font-family:sans-serif;max-width:480px;margin:80px auto;padding:32px;text-align:center">
        <h2 style="color:#ef4444">Passwords don't match</h2>
        <a href="/auth/reset-password?token=${token}">Try again</a>
      </body></html>
    `);
    if (password.length < 8) return res.status(400).send("Password must be at least 8 characters.");

    const { rows } = await db.query(
      `SELECT * FROM password_reset_tokens
       WHERE token = $1 AND expires_at > NOW() AND used_at IS NULL`,
      [token]
    );
    if (!rows.length) return res.status(400).send("Invalid or expired reset link.");

    const resetToken = rows[0];
    const hash = await bcrypt.hash(password, SALT_ROUNDS);

    await db.query("UPDATE users SET password_hash = $1 WHERE id = $2", [hash, resetToken.user_id]);
    await db.query("UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1", [resetToken.id]);

    res.send(`
      <html><body style="font-family:sans-serif;max-width:480px;margin:80px auto;padding:32px;text-align:center">
        <h2 style="color:#7c3aed">Password updated</h2>
        <p>Your password has been reset. Open PostKraft and log in with your new password.</p>
      </body></html>
    `);
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
