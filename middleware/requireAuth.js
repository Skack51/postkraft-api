const jwt = require("jsonwebtoken");
const db = require("../db");

/**
 * Middleware: require a valid JWT in the Authorization header.
 * Attaches req.user = { id, email, subscription_status } on success.
 */
async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or invalid Authorization header" });
  }

  const token = header.slice(7);
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: "Token expired or invalid" });
  }

  // Pull fresh user data so we always have current subscription_status
  const { rows } = await db.query(
    "SELECT id, email, full_name, subscription_status FROM users WHERE id = $1",
    [payload.sub]
  );
  if (!rows.length) {
    return res.status(401).json({ error: "User not found" });
  }

  req.user = rows[0];
  next();
}

module.exports = requireAuth;
