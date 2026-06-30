const express = require("express");
const cors = require("cors");
const db = require("../db");

const router = express.Router();

// Waitlist is public — allow any origin (file://, web, Electron)
router.use(cors());

const VALID_SOURCES = ["real_estate", "restaurant", "retail", "conference_2026"];

// First 100 conference_2026 signups lock in $49/month for life.
const FOUNDING_CAP = 100;
// Public counter on the conference page stays hidden until this many spots claimed.
const COUNTER_REVEAL_AT = 50;
// Advisory-lock key — any int unique to "conference founding allocation".
// Stays well inside JS safe-integer range; pg driver serializes as int8.
const FOUNDING_LOCK_KEY = 902614000001;

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
};

function conferenceFounderCopy(foundingNumber) {
  return {
    subject: `You claimed founding spot #${foundingNumber} — locked at $49/mo for life`,
    headline: "You're in. And you locked the founding rate.",
    body: `Thanks for scanning at the conference. Here's exactly what happens next.<br/><br/>You're <strong>founding member #${foundingNumber} of ${FOUNDING_CAP}</strong> — which means you've locked in the <strong>$49/month founding rate for life</strong> (instead of the standard $79), as long as you stay subscribed.<br/><br/>I'm hand-activating every conference attendee this week. Within 48 hours, you'll get a separate email from me with your download link for the PostKraft Mac app, your <strong>CONFERENCE26</strong> activation code that unlocks 30 days completely free, and your founding rate already wired into your account.<br/><br/>Only ${FOUNDING_CAP} of these spots exist. You're in.`,
  };
}

function conferenceLateCopy() {
  return {
    subject: "Your PostKraft access — what happens next",
    headline: "You're in.",
    body: `Thanks for scanning at the conference. Here's exactly what happens next.<br/><br/>The founding cohort of ${FOUNDING_CAP} ($49/month for life) is fully claimed, but you're locked in on the standard rate of $79/month after your free month.<br/><br/>I'm hand-activating every conference attendee this week. Within 48 hours, you'll get a separate email from me with your download link, your <strong>CONFERENCE26</strong> activation code, and your account ready to go.`,
  };
}

function copyFor(source, foundingNumber) {
  if (source === "conference_2026") {
    return foundingNumber
      ? conferenceFounderCopy(foundingNumber)
      : conferenceLateCopy();
  }
  return SOURCE_COPY[source] || SOURCE_COPY.real_estate;
}

function welcomeHtml(source, foundingNumber) {
  const { headline, body } = copyFor(source, foundingNumber);
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

function welcomeText(source, foundingNumber) {
  const { headline, body } = copyFor(source, foundingNumber);
  // Strip HTML tags from body so plain-text version renders cleanly
  const plainBody = body.replace(/<br\s*\/?>(\s*)/gi, "\n").replace(/<\/?(strong|b|em|i)>/gi, "");
  const isConference = source === "conference_2026";
  const followUp = isConference
    ? "If you have any questions before then, just reply to this email."
    : "I'll send a personal note the moment your account is ready. In the meantime, if you have a friend in the industry who'd want first access, forward this email — I'm keeping the founding cohort small on purpose.";
  return `${headline}\n\n${plainBody}\n\n${followUp}\n\nTalk soon,\nSean\n\n—\nSean Kalman · Founder, PostKraft\nThe Kalman Co. · Nantucket Island\n`;
}

async function sendWelcomeEmail(email, source, foundingNumber) {
  if (!process.env.RESEND_API_KEY) {
    console.warn("[waitlist] RESEND_API_KEY not set — skipping welcome email");
    return false;
  }
  try {
    const { subject } = copyFor(source, foundingNumber);
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
        subject,
        html: welcomeHtml(source, foundingNumber),
        text: welcomeText(source, foundingNumber),
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

/**
 * Atomically insert a conference_2026 row and (if there's a founding slot left)
 * assign it. Uses a Postgres transactional advisory lock so concurrent inserts
 * can't both grab the same founding number. Returns { row, foundingNumber }.
 *
 * row is null when the email already existed (ON CONFLICT did nothing).
 * foundingNumber is null when source isn't conference_2026 or the cap is hit.
 */
async function insertWaitlistRow(email, source) {
  const client = await db.getClient();
  try {
    await client.query("BEGIN");

    // Advisory lock only matters for conference_2026 — it serializes the
    // count-then-insert against other simultaneous conference signups.
    let foundingNumber = null;
    let foundingMember = false;
    if (source === "conference_2026") {
      await client.query("SELECT pg_advisory_xact_lock($1)", [FOUNDING_LOCK_KEY]);
      const { rows: countRows } = await client.query(
        `SELECT COUNT(*)::int AS claimed
         FROM waitlist
         WHERE source = 'conference_2026' AND founding_member = TRUE`
      );
      const claimed = countRows[0]?.claimed ?? 0;
      if (claimed < FOUNDING_CAP) {
        foundingNumber = claimed + 1;
        foundingMember = true;
      }
    }

    const { rows } = await client.query(
      `INSERT INTO waitlist (email, source, founding_member, founding_number)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email, source) DO NOTHING
       RETURNING id, founding_member, founding_number`,
      [email, source, foundingMember, foundingNumber]
    );

    if (rows.length === 0) {
      // Duplicate email — fetch the existing row so we can echo their actual
      // founding status back. The slot we tentatively reserved wasn't used; the
      // advisory lock release on COMMIT lets the next signup claim it.
      const { rows: existing } = await client.query(
        `SELECT id, founding_member, founding_number
         FROM waitlist
         WHERE email = $1 AND source = $2`,
        [email, source]
      );
      await client.query("COMMIT");
      const ex = existing[0];
      return {
        row: null, // null = no fresh insert (so no welcome email re-send)
        foundingNumber: ex?.founding_number ?? null,
        alreadyFounding: Boolean(ex?.founding_member),
      };
    }

    await client.query("COMMIT");
    return {
      row: rows[0],
      foundingNumber: rows[0].founding_number,
      alreadyFounding: false,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
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

    const { row, foundingNumber, alreadyFounding } = await insertWaitlistRow(cleanEmail, cleanSource);

    // Respond immediately — don't make the user wait on Resend.
    // For duplicates, echo their actual founding status so the success message
    // matches reality.
    res.json({
      success: true,
      foundingMember: Boolean(row?.founding_member) || alreadyFounding,
      foundingNumber: foundingNumber || null,
      duplicate: !row,
    });

    // Fire welcome email async (only on a fresh signup)
    if (row) {
      sendWelcomeEmail(cleanEmail, cleanSource, foundingNumber)
        .then((ok) => {
          if (ok) {
            return db.query(
              `UPDATE waitlist SET notified = TRUE WHERE id = $1`,
              [row.id]
            );
          }
        })
        .catch((err) => console.error("[waitlist] post-response error:", err));
    }
  } catch (err) {
    next(err);
  }
});

// GET /waitlist/founding-status
// Public — used by the conference landing page to render the scarcity counter.
// Counter stays hidden until COUNTER_REVEAL_AT spots are claimed.
router.get("/founding-status", async (_req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS claimed
       FROM waitlist
       WHERE source = 'conference_2026' AND founding_member = TRUE`
    );
    const claimed = rows[0]?.claimed ?? 0;
    res.json({
      claimed,
      total: FOUNDING_CAP,
      remaining: Math.max(0, FOUNDING_CAP - claimed),
      showCounter: claimed >= COUNTER_REVEAL_AT,
      revealAt: COUNTER_REVEAL_AT,
      soldOut: claimed >= FOUNDING_CAP,
    });
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
