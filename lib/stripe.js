const Stripe = require("stripe");

// Singleton — instantiated once, reused everywhere
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-04-10",
});

module.exports = stripe;
