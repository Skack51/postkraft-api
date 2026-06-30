const express = require("express");
const db = require("../db");
const requireAuth = require("../middleware/requireAuth");
const requireSubscription = require("../middleware/requireSubscription");

const router = express.Router();

// Cloud photo pool is a paid-tier feature — gate everything.
router.use(requireAuth, requireSubscription);

// Allowed orientation values; anything else is stored as NULL.
const ORIENTATIONS = new Set(["portrait", "landscape", "square"]);

function deriveOrientation(width, height, fallback) {
  if (fallback && ORIENTATIONS.has(fallback)) return fallback;
  if (!width || !height) return null;
  if (width === height) return "square";
  return width > height ? "landscape" : "portrait";
}

// ── POST /photos/sync ──────────────────────────────────────────────────────────
// The desktop app uploads chosen photos to Cloudinary, then registers them here
// so the cloud weekly batch can draw from them even when the Mac is off.
// Body: { photos: [{ cloudinaryUrl, sourceName?, width?, height?, orientation?, tags? }] }
// Re-syncing the same Cloudinary URL is a no-op (deduped per user).
router.post("/sync", async (req, res, next) => {
  try {
    const { photos } = req.body;
    if (!Array.isArray(photos) || photos.length === 0) {
      return res.status(400).json({ error: "photos array is required" });
    }
    if (photos.length > 500) {
      return res.status(400).json({ error: "Too many photos in one sync (max 500)" });
    }

    const inserted = [];
    const skipped = [];

    for (const p of photos) {
      const url = (p.cloudinaryUrl || p.cloudinary_url || "").trim();
      if (!url || !/^https:\/\//i.test(url)) {
        skipped.push({ photo: p, reason: "missing or non-https cloudinaryUrl" });
        continue;
      }

      const width = Number.isFinite(p.width) ? p.width : null;
      const height = Number.isFinite(p.height) ? p.height : null;
      const orientation = deriveOrientation(width, height, p.orientation);
      const tags = Array.isArray(p.tags)
        ? p.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 25)
        : [];

      // Dedupe on (user_id, cloudinary_url): the partial unique index below makes
      // this an upsert that refreshes metadata without resetting rotation counters.
      const { rows } = await db.query(
        `INSERT INTO photo_pool (user_id, cloudinary_url, source_name, orientation, width, height, tags)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (user_id, cloudinary_url) DO UPDATE
           SET source_name = COALESCE(EXCLUDED.source_name, photo_pool.source_name),
               orientation = COALESCE(EXCLUDED.orientation, photo_pool.orientation),
               width       = COALESCE(EXCLUDED.width, photo_pool.width),
               height      = COALESCE(EXCLUDED.height, photo_pool.height),
               tags        = CASE WHEN cardinality(EXCLUDED.tags) > 0
                                  THEN EXCLUDED.tags ELSE photo_pool.tags END
         RETURNING id, (xmax = 0) AS is_new`,
        [req.user.id, url, p.sourceName || p.source_name || null, orientation, width, height, tags]
      );

      if (rows[0]?.is_new) inserted.push(rows[0].id);
      else skipped.push({ id: rows[0]?.id, reason: "already in pool (metadata refreshed)" });
    }

    res.json({ success: true, added: inserted.length, refreshed: skipped.length, pool_ids: inserted });
  } catch (err) {
    next(err);
  }
});

// ── GET /photos ────────────────────────────────────────────────────────────────
// List the user's pool so they can review / prune what feeds generation.
router.get("/", async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, cloudinary_url, source_name, orientation, width, height, tags,
              used_count, last_used_at, created_at
       FROM photo_pool
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json({ count: rows.length, photos: rows });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /photos/:id ───────────────────────────────────────────────────────────
// Remove a photo from the pool. Returns 404 if it isn't the user's photo.
router.delete("/:id", async (req, res, next) => {
  try {
    const { rowCount } = await db.query(
      `DELETE FROM photo_pool WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (rowCount === 0) {
      return res.status(404).json({ error: "Photo not found in your pool" });
    }
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
