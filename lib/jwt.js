const jwt = require("jsonwebtoken");

/**
 * Issue a JWT for a user.
 * @param {object} user - must have id and email
 * @returns {string} signed JWT
 */
function signToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
  );
}

module.exports = { signToken };
