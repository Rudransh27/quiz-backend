// src/services/auth/audit.js
//
// Writes the authentication audit log (models/AuthEvent.js). Only safe,
// non-secret fields are accepted; anything else a caller passes is dropped.
// A failed audit write is logged and never blocks a sign-in or sign-out.
const AuthEvent = require("../../models/AuthEvent");
const { methodOf } = require("./providers");

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,24}$/i;
const REASON_RE = /^[a-z_]{1,40}$/;

// IP (Express resolves it through the trusted proxy — server.js sets
// "trust proxy") and a trimmed user-agent string.
function clientInfo(req) {
  if (!req) return { ip: null, userAgent: null };
  const ua = typeof req.get === "function" ? req.get("user-agent") : null;
  return {
    ip: req.ip ? String(req.ip).slice(0, 64) : null,
    userAgent: ua ? String(ua).slice(0, 300) : null,
  };
}

async function recordAuthEvent({
  type, req = null, userId = null, email = null, provider = null, method,
  success, reason = null, sessionId = null, actorId = null,
}) {
  try {
    const cleanEmail = typeof email === "string" && EMAIL_RE.test(email.trim()) ? email.trim().toLowerCase() : null;
    const cleanReason = reason ? (REASON_RE.test(reason) ? reason : "other") : null;
    await AuthEvent.create({
      type,
      user_id: userId || null,
      email: cleanEmail,
      provider: provider || null,
      method: method !== undefined ? method : methodOf(provider),
      success: !!success,
      reason: cleanReason,
      sessionId: sessionId ? String(sessionId).slice(0, 64) : null,
      actor_id: actorId || null,
      ...clientInfo(req),
    });
  } catch (err) {
    console.error("⚠️ Auth audit write failed:", err.message);
  }
}

module.exports = { recordAuthEvent, clientInfo };
