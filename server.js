require("dotenv").config();
const express = require("express");
const cors = require("cors");

const authRoutes = require("./routes/auth");
const billingRoutes = require("./routes/billing");
const oauthRoutes = require("./routes/oauth");
const aiRoutes = require("./routes/ai");

const app = express();

// ─── Stripe webhook needs raw body ──────────────────────────────────────────
app.use("/billing/webhook", express.raw({ type: "application/json" }));

// ─── Everything else gets JSON ───────────────────────────────────────────────
app.use(express.json());

// ─── CORS ────────────────────────────────────────────────────────────────────
// Allow requests from the Electron app (file://) and future web dashboard
app.use(
  cors({
    origin: (origin, cb) => {
      // Allow Electron (no origin), localhost dev, and future web app
      const allowed = [undefined, null, "http://localhost:5173", "https://postkraft.com"];
      if (!origin || allowed.includes(origin)) return cb(null, true);
      cb(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);

// ─── Health check ────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ status: "ok", ts: Date.now() }));

// ─── Routes ──────────────────────────────────────────────────────────────────
app.use("/auth", authRoutes);
app.use("/billing", billingRoutes);
app.use("/oauth", oauthRoutes);
app.use("/ai", aiRoutes);

// ─── 404 ─────────────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: "Not found" }));

// ─── Global error handler ────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({ error: err.message || "Internal server error" });
});

// ─── Start ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`PostKraft API running on port ${PORT}`);
});
