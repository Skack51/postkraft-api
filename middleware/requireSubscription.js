/**
 * Middleware: require an active or trialing subscription.
 * Must come AFTER requireAuth (needs req.user).
 */
function requireSubscription(req, res, next) {
  const { subscription_status } = req.user;
  if (subscription_status === "active" || subscription_status === "trialing") {
    return next();
  }
  return res.status(402).json({
    error: "Subscription required",
    subscription_status,
    upgrade_url: "https://postkraft.com/billing",
  });
}

module.exports = requireSubscription;
