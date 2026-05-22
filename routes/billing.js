const express = require("express");
const stripe = require("../lib/stripe");
const db = require("../db");
const requireAuth = require("../middleware/requireAuth");

const router = express.Router();

// ─── POST /billing/subscribe ──────────────────────────────────────────────────
// Creates a Stripe Checkout session. Electron opens this URL in the browser.
// Returns: { checkout_url }
router.post("/subscribe", requireAuth, async (req, res, next) => {
  try {
    const user = req.user;

    // Create or reuse Stripe customer
    let customerId = await getOrCreateStripeCustomer(user);

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      // 7-day free trial (overridden to 30 days when CONFERENCE26 coupon is applied)
      subscription_data: { trial_period_days: 7 },
      // Let users enter promo codes at checkout (e.g. CONFERENCE26 = 30 days free)
      allow_promotion_codes: true,
      // After checkout, deep-link back into the Electron app
      success_url: `postkraft://billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `postkraft://billing/cancel`,
      metadata: { user_id: user.id },
    });

    res.json({ checkout_url: session.url });
  } catch (err) {
    next(err);
  }
});

// ─── GET /billing/status ──────────────────────────────────────────────────────
// Returns current subscription status for the logged-in user.
router.get("/status", requireAuth, async (req, res) => {
  const { rows } = await db.query(
    `SELECT subscription_status, trial_ends_at, current_period_end
     FROM users WHERE id = $1`,
    [req.user.id]
  );
  res.json(rows[0]);
});

// ─── POST /billing/portal ─────────────────────────────────────────────────────
// Opens Stripe Customer Portal (manage payment method, cancel, etc.)
router.post("/portal", requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      "SELECT stripe_customer_id FROM users WHERE id = $1",
      [req.user.id]
    );
    if (!rows[0]?.stripe_customer_id) {
      return res.status(400).json({ error: "No billing account found" });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: rows[0].stripe_customer_id,
      return_url: "postkraft://billing/portal-return",
    });

    res.json({ portal_url: session.url });
  } catch (err) {
    next(err);
  }
});

// ─── POST /billing/cancel ─────────────────────────────────────────────────────
// Cancels the subscription at the end of the current billing period.
// The user keeps access until the period ends — no immediate cutoff.
router.post("/cancel", requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      "SELECT subscription_id FROM users WHERE id = $1",
      [req.user.id]
    );

    const subscriptionId = rows[0]?.subscription_id;
    if (!subscriptionId) {
      return res.status(400).json({ error: "No active subscription found" });
    }

    const sub = await stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: true,
    });

    // DO NOT flip subscription_status to 'canceled' here — the user paid for
    // the period and should keep access until current_period_end. The
    // customer.subscription.updated and customer.subscription.deleted
    // webhooks will reflect the real state when Stripe transitions it.

    console.log(`🚫 Subscription scheduled for cancellation at period end: ${subscriptionId}`);
    res.json({
      success: true,
      cancel_at_period_end: true,
      access_ends_at: new Date(sub.current_period_end * 1000),
    });
  } catch (err) {
    next(err);
  }
});

// ─── POST /billing/webhook ────────────────────────────────────────────────────
// Stripe sends events here. Must verify signature. Raw body required (set in server.js).
router.post("/webhook", async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    await handleStripeEvent(event);
    res.json({ received: true });
  } catch (err) {
    console.error("Webhook handler error:", err);
    res.status(500).json({ error: "Webhook handler failed" });
  }
});

// ─── Stripe event handler ─────────────────────────────────────────────────────
async function handleStripeEvent(event) {
  const { type, data } = event;

  switch (type) {
    case "checkout.session.completed": {
      // Payment succeeded — subscription is now active (or trialing)
      const session = data.object;
      const userId = session.metadata?.user_id;
      if (!userId) break;

      // Retrieve full subscription details
      const sub = await stripe.subscriptions.retrieve(session.subscription);

      await db.query(
        `UPDATE users SET
           stripe_customer_id  = $1,
           subscription_id     = $2,
           subscription_status = $3,
           trial_ends_at       = $4,
           current_period_end  = $5
         WHERE id = $6`,
        [
          session.customer,
          sub.id,
          sub.status,
          sub.trial_end ? new Date(sub.trial_end * 1000) : null,
          new Date(sub.current_period_end * 1000),
          userId,
        ]
      );
      console.log(`✅ Subscription activated for user ${userId}`);
      break;
    }

    case "customer.subscription.updated": {
      // Status change: active ↔ past_due, trialing → active, etc.
      const sub = data.object;
      await db.query(
        `UPDATE users SET
           subscription_status = $1,
           current_period_end  = $2,
           trial_ends_at       = $3
         WHERE subscription_id = $4`,
        [
          sub.status,
          new Date(sub.current_period_end * 1000),
          sub.trial_end ? new Date(sub.trial_end * 1000) : null,
          sub.id,
        ]
      );
      console.log(`♻️  Subscription updated: ${sub.id} → ${sub.status}`);
      break;
    }

    case "customer.subscription.deleted": {
      // Subscription canceled (at period end or immediately)
      const sub = data.object;
      await db.query(
        `UPDATE users SET subscription_status = 'canceled' WHERE subscription_id = $1`,
        [sub.id]
      );
      console.log(`❌ Subscription canceled: ${sub.id}`);
      break;
    }

    case "invoice.payment_failed": {
      // Card declined — Stripe will retry, but flag the account
      const invoice = data.object;
      await db.query(
        `UPDATE users SET subscription_status = 'past_due'
         WHERE stripe_customer_id = $1`,
        [invoice.customer]
      );
      console.log(`⚠️  Payment failed for customer ${invoice.customer}`);
      break;
    }

    case "customer.subscription.trial_will_end": {
      // Fires ~3 days before trial_end. Stripe also sends its own customer
      // email if enabled in Settings → Subscriptions and emails. We log it
      // here for visibility and as a hook for future automation
      // (e.g. concierge SMS to comped beta users).
      const sub = data.object;
      const { rows } = await db.query(
        `SELECT id, email, full_name FROM users WHERE subscription_id = $1`,
        [sub.id]
      );
      const user = rows[0];
      console.log(
        `⏰ Trial ending soon: sub ${sub.id} for ${user?.email || "unknown"} ` +
          `(trial_end: ${new Date(sub.trial_end * 1000).toISOString()})`
      );
      break;
    }

    default:
      // Ignore unhandled event types
      break;
  }
}

// ─── Helper: get or create a Stripe Customer for this user ───────────────────
async function getOrCreateStripeCustomer(user) {
  // Check if they already have one
  const { rows } = await db.query(
    "SELECT stripe_customer_id FROM users WHERE id = $1",
    [user.id]
  );
  if (rows[0]?.stripe_customer_id) return rows[0].stripe_customer_id;

  // Create new
  const customer = await stripe.customers.create({
    email: user.email,
    name: user.full_name || undefined,
    metadata: { postkraft_user_id: user.id },
  });

  await db.query(
    "UPDATE users SET stripe_customer_id = $1 WHERE id = $2",
    [customer.id, user.id]
  );

  return customer.id;
}

module.exports = router;
