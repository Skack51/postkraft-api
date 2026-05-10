const express = require("express");
const db = require("../db");
const requireAuth = require("../middleware/requireAuth");
const requireSubscription = require("../middleware/requireSubscription");

const router = express.Router();

router.use(requireAuth, requireSubscription);

// ── POST /schedule — create a scheduled post ───────────────────────────────────
// Body: { platform, caption, hashtags, cta, imageUrl, scheduledAt }
// imageUrl should already be a Cloudinary URL (uploaded by the app before scheduling)
router.post("/", async (req, res, next) => {
  try {
    const { platform, caption, hashtags, cta, imageUrl, scheduledAt } = req.body;

    if (!platform || !caption || !scheduledAt) {
      return res.status(400).json({ error: "platform, caption, and scheduledAt are required" });
    }

    const { rows } = await db.query(
      `INSERT INTO scheduled_posts (user_id, platform, caption, hashtags, cta, image_url, scheduled_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [req.user.id, platform, caption, hashtags || "", cta || "", imageUrl || null, scheduledAt]
    );

    res.json({ success: true, post: rows[0] });
  } catch (err) {
    next(err);
  }
});

// ── GET /schedule — list pending scheduled posts for user ──────────────────────
router.get("/", async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM scheduled_posts
       WHERE user_id = $1 AND status IN ('pending', 'failed')
       ORDER BY scheduled_at ASC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ── DELETE /schedule/:id — cancel a scheduled post ────────────────────────────
router.delete("/:id", async (req, res, next) => {
  try {
    await db.query(
      `UPDATE scheduled_posts SET status = 'canceled'
       WHERE id = $1 AND user_id = $2 AND status = 'pending'`,
      [req.params.id, req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /schedule/:id — reschedule a post ────────────────────────────────────
router.patch("/:id", async (req, res, next) => {
  try {
    const { scheduledAt } = req.body;
    if (!scheduledAt) return res.status(400).json({ error: "scheduledAt required" });

    const { rows } = await db.query(
      `UPDATE scheduled_posts SET scheduled_at = $1, status = 'pending', error = NULL
       WHERE id = $2 AND user_id = $3
       RETURNING *`,
      [scheduledAt, req.params.id, req.user.id]
    );
    res.json({ success: true, post: rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
