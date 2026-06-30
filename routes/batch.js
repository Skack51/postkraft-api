const express = require("express");
const db = require("../db");
const requireAuth = require("../middleware/requireAuth");
const requireSubscription = require("../middleware/requireSubscription");
const { generateCaption } = require("../lib/batchGenerator");

const router = express.Router();

// Weekly batch review is a paid-tier feature.
router.use(requireAuth, requireSubscription);

// ── GET /batch/current ───────────────────────────────────────────────────────────
// The most recent batch run for the user, plus its draft posts for review.
router.get("/current", async (req, res, next) => {
  try {
    const { rows: runs } = await db.query(
      `SELECT id, week_of, status, posts_count, error, created_at
       FROM batch_runs
       WHERE user_id = $1
       ORDER BY week_of DESC
       LIMIT 1`,
      [req.user.id]
    );
    if (!runs.length) return res.json({ run: null, drafts: [] });

    const run = runs[0];
    const { rows: drafts } = await db.query(
      `SELECT id, platform, caption, hashtags, cta, image_url, scheduled_at, status
       FROM scheduled_posts
       WHERE batch_run_id = $1 AND user_id = $2 AND status = 'draft'
       ORDER BY scheduled_at ASC`,
      [run.id, req.user.id]
    );
    res.json({ run, drafts });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /batch/post/:id ─────────────────────────────────────────────────────────
// Edit a single draft before approving. Body may include any of:
//   caption, hashtags, cta, imageUrl, scheduledAt
// Only drafts owned by the user are editable.
router.patch("/post/:id", async (req, res, next) => {
  try {
    const { caption, hashtags, cta, imageUrl, scheduledAt } = req.body;

    const sets = [];
    const params = [];
    const set = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };

    if (caption !== undefined) set("caption", caption);
    if (hashtags !== undefined) set("hashtags", hashtags);
    if (cta !== undefined) set("cta", cta);
    if (imageUrl !== undefined) set("image_url", imageUrl);
    if (scheduledAt !== undefined) set("scheduled_at", scheduledAt);

    if (!sets.length) return res.status(400).json({ error: "No editable fields provided" });

    params.push(req.params.id, req.user.id);
    const { rows } = await db.query(
      `UPDATE scheduled_posts SET ${sets.join(", ")}
       WHERE id = $${params.length - 1} AND user_id = $${params.length} AND status = 'draft'
       RETURNING id, platform, caption, hashtags, cta, image_url, scheduled_at, status`,
      params
    );
    if (!rows.length) {
      return res.status(404).json({ error: "Draft not found (or already approved)" });
    }
    res.json({ success: true, post: rows[0] });
  } catch (err) {
    next(err);
  }
});

// ── POST /batch/regenerate ────────────────────────────────────────────────────────
// Re-roll a single draft's caption, optionally swapping the photo first.
// Body: { postId, newImageUrl? }
router.post("/regenerate", async (req, res, next) => {
  try {
    const { postId, newImageUrl } = req.body;
    if (!postId) return res.status(400).json({ error: "postId is required" });

    const { rows } = await db.query(
      `SELECT id, platform, image_url FROM scheduled_posts
       WHERE id = $1 AND user_id = $2 AND status = 'draft'`,
      [postId, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Draft not found" });

    const draft = rows[0];
    const imageUrl = newImageUrl || draft.image_url;
    if (!imageUrl) return res.status(400).json({ error: "Draft has no image to caption" });

    // Pull the user's stored voice so re-rolls stay on-brand.
    const { rows: prefRows } = await db.query(
      `SELECT memory_snapshot FROM content_prefs WHERE user_id = $1`,
      [req.user.id]
    );
    const memory = prefRows[0]?.memory_snapshot || "";

    const cap = await generateCaption(draft.platform, imageUrl, memory);

    const { rows: updated } = await db.query(
      `UPDATE scheduled_posts
       SET caption = $1, hashtags = $2, cta = $3, image_url = $4
       WHERE id = $5 AND user_id = $6 AND status = 'draft'
       RETURNING id, platform, caption, hashtags, cta, image_url, scheduled_at, status`,
      [cap.caption, cap.hashtags, cap.cta, imageUrl, postId, req.user.id]
    );

    await db.query(
      `INSERT INTO usage_events (user_id, kind, units) VALUES ($1, 'caption', 1)`,
      [req.user.id]
    );

    res.json({ success: true, post: updated[0] });
  } catch (err) {
    next(err);
  }
});

// ── POST /batch/:id/approve ───────────────────────────────────────────────────────
// Approve a batch run's drafts → flip them to 'pending' so the existing
// every-minute scheduler fires them at their scheduled_at. Optionally approve a
// subset via body.postIds; omit to approve all drafts in the run.
router.post("/:id/approve", async (req, res, next) => {
  try {
    const { postIds } = req.body || {};

    // Confirm the run belongs to the user.
    const { rows: runs } = await db.query(
      `SELECT id FROM batch_runs WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (!runs.length) return res.status(404).json({ error: "Batch run not found" });

    let result;
    if (Array.isArray(postIds) && postIds.length) {
      result = await db.query(
        `UPDATE scheduled_posts SET status = 'pending'
         WHERE batch_run_id = $1 AND user_id = $2 AND status = 'draft' AND id = ANY($3)`,
        [req.params.id, req.user.id, postIds]
      );
    } else {
      result = await db.query(
        `UPDATE scheduled_posts SET status = 'pending'
         WHERE batch_run_id = $1 AND user_id = $2 AND status = 'draft'`,
        [req.params.id, req.user.id]
      );
    }

    await db.query(
      `UPDATE batch_runs SET status = 'approved' WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );

    res.json({ success: true, approved: result.rowCount });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
