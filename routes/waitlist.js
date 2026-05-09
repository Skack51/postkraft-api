const express = require("express");
const db = require("../db");

const router = express.Router();

const VALID_SOURCES = ["real_estate", "restaurant", "retail"];

// POST /waitlist
// Body: { email, source? }
// Public — no auth required
router.post("/", async (req, res, next) => {
  try {
    const { email, source = "real_estate" } = req.body;

    if (!email || !email.includes("@")) {
      return res.status(400).json({ error: "Valid email is required" });
    }

    const cleanSource = VALID_SOURCES.includes(source) ? source : "real_estate";

    await db.query(
      `INSERT INTO waitlist (email, source)
       VALUES ($1, $2)
       ON CONFLICT (email, source) DO NOTHING`,
      [email.toLowerCase().trim(), cleanSource]
    );

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// GET /waitlist — simple count (no auth for now, just for quick checks)
router.get("/count", async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT source, COUNT(*) as count FROM waitlist GROUP BY source ORDER BY source`
    );
    res.json({ totals: rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
