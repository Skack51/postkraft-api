/**
 * Middleware: require an active or trialing subscription.
 * Must come AFTER requireAuth (needs req.user).
 *
 * Stripe statuses we may see:
 *   active, trialing      → access granted
 *   past_due, paused      → access denied, but recoverable via Customer Portal
 *   canceled, unpaid,     → access denied, must re-subscribe
 *   incomplete, inactive
 */
function requireSubscription(req, res, next) {
  const { subscription_status } = req.user;
  if (subscription_status === "active" || subscription_status === "trialing") {
    return next();
  }

  // Recoverable states — user can fix by adding/updating a payment method.
  // `paused` is what happens to beta/comp accounts when the trial ends with
  // no payment method on file (trial_settings.end_behavior.missing_payment_method=pause).
  const recoverable = subscription_status === "past_due" || subscription_status === "paused";

  return res.status(402).json({
    error: "Subscription required",
    subscription_status,
    recoverable,
    message: recoverable
      ? "Your subscription needs a payment method. Open Settings → Billing in PostKraft to add one."
      : "Your subscription is not active. Open Settings → Billing in PostKraft to subscribe.",
    upgrade_url: "https://postkraft.app/billing",
  });
}

module.exports = requireSubscription;
