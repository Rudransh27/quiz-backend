// src/middleware/rateLimiters.js
const rateLimit = require("express-rate-limit");

// IP-based throttle for the login endpoint — the VAPT PoC drives Burp
// Intruder through this route with a password wordlist. This caps how many
// attempts any single IP can make regardless of which account it's
// guessing against, which complements (not replaces) the per-account
// lockout in authRoutes.js — that one alone wouldn't stop a
// credential-stuffing sweep across many different accounts from one IP.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many login attempts from this network. Please try again in 15 minutes." },
});

// Same automated-guessing threat model applies to the 6-digit email OTP
// (1,000,000 possible codes, 10-minute expiry) — without a limit here an
// attacker can brute-force the OTP directly instead of the password. 10
// attempts per window makes exhausting the keyspace before it expires
// infeasible without needing a separate per-account lockout mechanism.
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many verification attempts. Please request a new code and try again later." },
});

// Password-reset request flooding (VAPT finding #3, Medium/CWE-770-adjacent
// abuse) — with no limit here, POST /forgot-password can be hit thousands of
// times for one victim's email, and every hit sends them a real email, i.e.
// the endpoint becomes a mail bomb aimed at someone else's inbox. Tighter
// than the login limiter since a real user only ever needs this a handful
// of times per session, never dozens.
const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many password reset requests from this network. Please try again in 15 minutes." },
});

module.exports = { loginLimiter, otpLimiter, forgotPasswordLimiter };
