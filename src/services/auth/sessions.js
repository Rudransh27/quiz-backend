// src/services/auth/sessions.js
//
// IRIS Orbit application sessions (models/AuthSession.js).
//  • startSession   — every successful sign-in, whatever the provider: new
//                     random sessionId (never reused, so a session can't be
//                     fixed in advance), "last login" on the user, audit event.
//  • checkSession   — called by middleware/auth.js on every request.
//  • closeSession / endUserSessions — logout, expiry, revoke, password events.
// Several sessions per user (one per device) are allowed unless
// AUTH_SINGLE_SESSION=true (services/auth/providers.js policy).
const crypto = require("crypto");
const AuthSession = require("../../models/AuthSession");
const User = require("../../models/User");
const { recordAuthEvent, clientInfo } = require("./audit");
const { methodOf, policy } = require("./providers");

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // = the JWT's expiresIn "1d"
const SEEN_EVERY_MS = 5 * 60 * 1000;         // lastSeenAt is refreshed at most this often

const EVENT_FOR_REASON = {
  logout: "LOGOUT",
  expired: "SESSION_EXPIRED",
  revoked: "SESSION_REVOKED",
  password_changed: "SESSION_REVOKED",
  password_reset: "SESSION_REVOKED",
  replaced: "SESSION_REVOKED",
};

// `isLogin: false` = a replacement session for someone already signed in
// (after changing their password): no login event, "last login" unchanged.
async function startSession({ req, user, provider, isLogin = true }) {
  const sessionId = crypto.randomUUID();
  const method = methodOf(provider);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await AuthSession.create({ sessionId, user_id: user._id, provider, method, ...clientInfo(req), expiresAt, lastSeenAt: now });
  if (!isLogin) return { sessionId, expiresAt };
  if (policy.singleSession) await endUserSessions(user._id, "replaced", { exceptSessionId: sessionId, req });
  await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: now, lastLoginMethod: method, lastLoginProvider: provider } });
  await recordAuthEvent({ type: "LOGIN_SUCCESS", req, userId: user._id, email: user.email, provider, success: true, sessionId });
  return { sessionId, expiresAt };
}

// Ends one session and records why (once — a second call is a no-op). A
// token from before session rows existed gets an ended row, so it can't be
// used again either.
// `eventReason` overrides the reason code written to the audit log (e.g.
// "idle" for a session the browser ended after inactivity).
async function closeSession({ sessionId, userId = null, reason, req = null, actorId = null, expiresAt = null, eventReason = null }) {
  if (!sessionId || !EVENT_FOR_REASON[reason]) return { ended: false };
  const now = new Date();
  let row = await AuthSession.findOneAndUpdate(
    { sessionId, endedAt: null },
    { $set: { endedAt: now, endReason: reason, endedBy: actorId || null } },
    { new: true },
  ).lean();
  if (!row) {
    if (!userId) return { ended: false };
    try {
      row = (await AuthSession.create({
        sessionId, user_id: userId, expiresAt: expiresAt || new Date(now.getTime() + SESSION_TTL_MS),
        endedAt: now, endReason: reason, endedBy: actorId || null, adopted: true, ...clientInfo(req),
      })).toObject();
    } catch (err) {
      if (err && err.code === 11000) return { ended: false }; // already ended
      throw err;
    }
  }
  await recordAuthEvent({
    type: EVENT_FOR_REASON[reason], req, userId: row.user_id, provider: row.provider, method: row.method,
    success: true, sessionId, reason: eventReason || (reason === "logout" || reason === "expired" ? null : reason), actorId,
  });
  notifySockets(row.user_id, sessionId);
  return { ended: true };
}

// Open browser tabs of that session sign out right away (App.jsx listens
// for "session_ended" and compares the id with its own token's).
function notifySockets(userId, sessionId) {
  const sockets = global.activeUserSockets && global.activeUserSockets.get(String(userId));
  if (!sockets || !global.io) return;
  sockets.forEach((socketId) => global.io.to(socketId).emit("session_ended", { sessionId }));
}

// Ends every active session of a user (optionally keeping one) and stamps
// the user so tokens issued before now that never got a session row are
// refused too. Returns how many sessions were ended.
async function endUserSessions(userId, reason, { exceptSessionId = null, req = null, actorId = null } = {}) {
  const now = new Date();
  const filter = { user_id: userId, endedAt: null, expiresAt: { $gt: now } };
  if (exceptSessionId) filter.sessionId = { $ne: exceptSessionId };
  const active = await AuthSession.find(filter, "sessionId").lean();
  let ended = 0;
  for (const s of active) {
    if ((await closeSession({ sessionId: s.sessionId, reason, req, actorId })).ended) ended += 1;
  }
  // A kept session (password change from this device) stays valid: its row
  // exists, and the cut-off below only applies to tokens without a row.
  await User.updateOne({ _id: userId }, { $set: { sessionsRevokedAt: now } });
  return ended;
}

// Is this token's session still active? `iat` / `exp` are the verified JWT's
// claims (seconds). `revokedBefore` is the user's sessionsRevokedAt.
async function checkSession({ sessionId, userId, iat, exp, req = null, revokedBefore = null }) {
  if (!sessionId) return { ok: false, reason: "revoked" };
  const now = new Date();
  const row = await AuthSession.findOne({ sessionId }, "user_id endedAt endReason lastSeenAt").lean();
  if (!row) {
    // A token issued before session rows existed: adopt it (so it can be
    // ended from now on) unless the user's sessions were revoked after it
    // was issued.
    if (revokedBefore && iat && iat * 1000 < new Date(revokedBefore).getTime()) return { ok: false, reason: "revoked" };
    try {
      await AuthSession.create({
        sessionId, user_id: userId, expiresAt: exp ? new Date(exp * 1000) : new Date(now.getTime() + SESSION_TTL_MS),
        lastSeenAt: now, adopted: true, ...clientInfo(req),
      });
    } catch (err) {
      if (!(err && err.code === 11000)) throw err;
      return checkSession({ sessionId, userId, iat, exp, req, revokedBefore: null });
    }
    return { ok: true };
  }
  if (String(row.user_id) !== String(userId)) return { ok: false, reason: "revoked" };
  if (row.endedAt) return { ok: false, reason: row.endReason === "expired" ? "expired" : "revoked", endReason: row.endReason };
  if (!row.lastSeenAt || now - new Date(row.lastSeenAt) > SEEN_EVERY_MS) {
    AuthSession.updateOne({ sessionId }, { $set: { lastSeenAt: now } }).catch(() => {});
  }
  return { ok: true };
}

module.exports = { startSession, closeSession, endUserSessions, checkSession, SESSION_TTL_MS };
