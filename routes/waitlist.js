const express = require("express");
const cors = require("cors");
const db = require("../db");

const router = express.Router();

// Waitlist is public — allow any origin (file://, web, Electron)
router.use(cors());

const VALID_SOURCES = ["real_estate", "restaurant", "retail", "conference_2026"];

const SOURCE_COPY = {
  real_estate: {
    subject: "You're on the PostKraft list",
    headline: "You're in.",
    body: "Thanks for jumping on the PostKraft waitlist. You're one of the first agents I'm building this for — your spot is locked at the founding member rate of $49/month, forever.",
  },
  restaurant: {
    subject: "You're on the PostKraft list",
    headline: "You're in.",
    body: "Thanks for jumping on the PostKraft waitlist. You're one of the first restaurants on the list — your spot is locked at the founding member rate of $49/month, forever.",
  },
  retail: {
    subject: "You're on the PostKraft list",
    headline: "You're in.",
    body: "Thanks for jumping on the PostKraft waitlist. You're one of the first retail brands on the list — your spot is locked at the founding member rate of $49/month, forever.",
  },
  conference_2026: {
    subject: "Your PostKraft access — what happens next",
    headline: "You're in.",
    body: "Thanks for scanning at the conference. Here's exactly what happens next.<br/><br/>I'm hand-activating every conference attendee this week. Within 48 hours, you'll get a separate email from me with your download link for the PostKraft Mac app, your <strong>CONFERENCE26</strong> activation code that unlocks 30 days completely free, and the founding member rate of $49/month locked in forever after your trial — instead of the standard $79.<br/><br/>I'm keeping the founding cohort small on purpose. You're in.",
  },
};

function welcomeHtml(source) {
  const { headline, body } = SOURCE_COPY[source] || SOURCE_COPY.real_estate;
  const isConference = source === "conference_2026";
  const followUp = isConference
    ? "If you have any questions before then, just reply to this email."
    : "I'll send a personal note the moment your account is ready. In the meantime, if you have a friend in the industry who'd want first access, forward this email — I'm keeping the founding cohort small on purpose.";
  return `<!doctype html><html><body style="margin:0;padding:0;background:#07070f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif;color:#f1f0ff;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#07070f;padding:48px 16px;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;background:#0d0d1a;border:1px solid rgba(255,255,255,0.07);border-radius:20px;padding:40px;">
        <tr><td>
          <div style="width:40px;height:40px;border-radius:10px;background:linear-gradient(135deg,#4da8f8,#7c2be8);display:inline-block;line-height:40px;text-align:center;font-weight:900;font-size:18px;color:white;margin-bottom:24px;">K</div>
          <h1 style="font-size:28px;font-weight:800;letter-spacing:-0.02em;line-height:1.2;margin:0 0 16px;color:#f1f0ff;">${headline}</h1>
          <p style="font-size:16px;line-height:1.7;color:rgba(255,255,255,0.75);margin:0 0 20px;">${body}</p>
          <p style="font-size:16px;line-height:1.7;color:rgba(255,255,255,0.75);margin:0 0 20px;">${followUp}</p>
          <p style="font-size:16px;line-height:1.7;color:rgba(255,255,255,0.75);margin:0 0 24px;">Talk soon,<br/>Sean</p>
          <hr style="border:none;border-top:1px solid rgba(255,255,255,0.07);margin:24px 0;"/>
          <p style="font-size:13px;color:rgba(255,255,255,0.45);margin:0;">Sean Kalman &nbsp;·&nbsp; Founder, PostKraft<br/>The Kalman Co. &nbsp;·&nbsp; Nantucket Island</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
  </body></html>`;
}

function welcomeText(source) {
  const { headline, body } = SOURCE_COPY[source] || SOURCE_COPY.real_estate;
  // Strip HTML tags from body so plain-text version renders cleanly
  const plainBody = body.replace(/<br\s*\/?>(\s*)/gi, "\n").replace(/<\/?(strong|b|em|i)>/gi, "");
  const isConference = source === "conference_2026";
  const followUp = isConference
    ? "If you have any questions before then, just reply to this email."
    : "I'll send a personal note the moment your account is ready. In the meantime, if you have a friend in the industry who'd want first access, forward this email — I'm keeping the founding cohort small on purpose.";
  return `${headline}\n\n${plainBody}\n\n${followUp}\n\nTalk soon,\nSean\n\n—\nSean Kalman · Founder, PostKraft\nThe Kalman Co. · Nantucket Island\n`;
}

async function sendWelcomeEmail(email, source) {
  if (!process.env.RESEND_API_KEY) {
    console.warn("[waitlist] RESEND_API_KEY not set — skipping welcome email");
    return false;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: "Sean Kalman <sean@postkraft.app>",
        reply_to: "sean@postkraft.app",
        to: [email],
        subject: SOURCE_COPY[source]?.subject || SOURCE_COPY.real_estate.subject,
        html: welcomeHtml(source),
        text: welcomeText(source),
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error(`[waitlist] Resend failed (${res.status}):`, errText);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[waitlist] Resend error:", err.message);
    return false;
  }
}

// POST /waitlist
// Body: { email, source? }
// Public — no auth required
router.post("/", async (req, res, next) => {
  try {
    const { email, source = "real_estate" } = req.body;

    if (!email || !email.includes("@")) {
      return res.status(400).json({ error: "Valid email is required" });
    }

    const cleanEmail = email.toLowerCase().trim();
    const cleanSource = VALID_SOURCES.includes(source) ? source : "real_estate";

    // RETURNING gives us a row only on a fresh insert — duplicates return nothing
    const { rows } = await db.query(
      `INSERT INTO waitlist (email, source)
       VALUES ($1, $2)
       ON CONFLICT (email, source) DO NOTHING
       RETURNING id`,
      [cleanEmail, cleanSource]
    );

    // Respond immediately — don't make the user wait on Resend
    res.json({ success: true });

    // Fire welcome email async (only on a fresh signup)
    if (rows.length > 0) {
      sendWelcomeEmail(cleanEmail, cleanSource)
        .then((ok) => {
          if (ok) {
            return db.query(
              `UPDATE waitlist SET notified = TRUE WHERE id = $1`,
              [rows[0].id]
            );
          }
        })
        .catch((err) => console.error("[waitlist] post-response error:", err));
    }
  } catch (err) {
    next(err);
  }
});

// GET /waitlist/count — quick check (no auth for now)
router.get("/count", async (_req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT source, COUNT(*)::int AS count
       FROM waitlist
       GROUP BY source
       ORDER BY source`
    );
    const totals = rows;
    const total = rows.reduce((sum, r) => sum + Number(r.count), 0);
    res.json({ total, totals });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
