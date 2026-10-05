// src/middleware/auth.js
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const User = require('../models/User');
const { checkSession, closeSession } = require('../services/auth/sessions');

const BINDING_MESSAGE = 'Session is not valid from this browser context. Please log in again.';
const EXPIRED = { status: 401, code: 'session_expired', message: 'Your session has expired. Please sign in again.' };
const REVOKED = { status: 401, code: 'session_revoked', message: 'This session was signed out. Please sign in again.' };

const bindingMatches = (contextUser, bindingSecret) => !!contextUser.bh && !!bindingSecret
  && crypto.createHash('sha256').update(bindingSecret).digest('hex') === contextUser.bh;

// An expired token from this browser: end its session row (once) so the
// expiry shows in the sign-in history, then answer "session expired".
async function expiredSession(rawToken, bindingSecret, req) {
  try {
    const stale = jwt.verify(rawToken, process.env.JWT_SECRET, { algorithms: ['HS256'], ignoreExpiration: true });
    const ctx = stale.user ? stale.user : stale;
    if (typeof ctx.sessionId === 'string' && ctx.id && bindingMatches(ctx, bindingSecret)) {
      await closeSession({ sessionId: ctx.sessionId, userId: ctx.id, reason: 'expired', req, expiresAt: stale.exp ? new Date(stale.exp * 1000) : null });
    }
  } catch (e) { /* not ours or tampered: just the plain answer below */ }
  return EXPIRED;
}

// Verifies a bearer token + its browser session-binding cookie, checks its
// IRIS Orbit session (services/auth/sessions) is still active, and loads the
// CURRENT user record. Shared by the HTTP middleware below and the Socket.IO
// handshake (server.js), so both apply exactly the same rules.
// Returns { user } or { status, message, code? }.
async function resolveSession({ token, bindingSecret, req = null }) {
  if (!token) return { status: 401, message: 'No token, authorization denied' };

  let decoded;
  const rawToken = String(token).replace('Bearer ', '');
  try {
    // Pin the accepted algorithm so a tampered/forged token using a
    // different alg (e.g. "none") is rejected outright by the library,
    // rather than relying on the caller to have configured this correctly.
    decoded = jwt.verify(rawToken, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch (err) {
    if (err && err.name === 'TokenExpiredError') return expiredSession(rawToken, bindingSecret, req);
    console.error("❌ Auth Token Validation Failure:", err.message);
    return { status: 401, message: 'Token is not valid' };
  }
  const contextUser = decoded.user ? decoded.user : decoded;

  // 🔐 SESSION-BINDING CHECK — a syntactically valid JWT for a real,
  // currently-privileged account is NOT enough on its own: it must also
  // arrive with the HttpOnly cookie issued to the same browser at login
  // (see authRoutes.js's issueBindingCookie). This is what stops a token
  // captured in a proxy (Burp) from one session and pasted into another
  // session's Authorization header — the pasted-into session never
  // received that session's binding cookie, so the hashes won't match
  // even though the token itself verifies perfectly fine.
  if (!contextUser.bh || !bindingSecret) return { status: 401, message: BINDING_MESSAGE };
  // Every token the app issues carries a sessionId (login / verify / SSO).
  // One without it never went through a login, and would also skip the
  // session check below — refuse it.
  if (typeof contextUser.sessionId !== 'string' || !contextUser.sessionId) return { status: 401, message: 'Token is not valid' };
  if (!bindingMatches(contextUser, bindingSecret)) {
    console.warn(`🚨 SESSION BINDING MISMATCH: a token for user ${contextUser.id} was presented without its matching browser session — likely token theft/replay.`);
    return { status: 401, message: BINDING_MESSAGE };
  }

  // Privilege/scope must be re-derived from the current database record on
  // every request, never trusted from the token payload — the JWT's claims
  // are frozen at login time (tokens live up to 24h), so an admin/superadmin
  // demotion, account deactivation, or a leaked/replayed token would
  // otherwise keep granting the ROLE BAKED IN AT ISSUANCE regardless of
  // what the account is actually authorized for right now.
  const dbUser = await User.findById(contextUser.id).select('role department team regions username passwordChangedAt sessionsRevokedAt');
  if (!dbUser) return { status: 401, message: 'Token is not valid' };
  // 🔒 A password change/reset ends every session issued before it, even
  // when Redis (the single-session store) is unavailable.
  if (dbUser.passwordChangedAt && typeof decoded.iat === 'number'
      && decoded.iat < Math.floor(dbUser.passwordChangedAt.getTime() / 1000)) {
    return { status: 401, message: 'Your password was changed. Please log in again.' };
  }

  // 🔒 The IRIS Orbit session must still be active: logout, an admin
  // ending it, a password change/reset elsewhere or (with
  // AUTH_SINGLE_SESSION) a newer login end it before the JWT expires.
  // Several sessions per user (one per device) are allowed.
  const session = await checkSession({
    sessionId: contextUser.sessionId,
    userId: dbUser._id,
    iat: decoded.iat,
    exp: decoded.exp,
    req,
    revokedBefore: dbUser.sessionsRevokedAt || null,
  });
  if (!session.ok) return session.reason === 'expired' ? EXPIRED : REVOKED;

  const user = {
    id: dbUser._id,
    role: dbUser.role,
    username: dbUser.username,
    sessionId: contextUser.sessionId,
    department: dbUser.department || null,
    team: dbUser.team || null,
    regions: dbUser.regions || [],
  };

  return { user };
}

module.exports = async function (req, res, next) {
  try {
    const result = await resolveSession({
      token: req.header('Authorization'),
      bindingSecret: req.cookies ? req.cookies.orbit_bind : undefined,
      req,
    });
    if (!result.user) return res.status(result.status).json({ message: result.message, ...(result.code ? { code: result.code } : {}) });
    req.user = result.user;
    next();
  } catch (err) {
    console.error("❌ Auth Token Validation Failure:", err.message);
    res.status(401).json({ message: 'Token is not valid' });
  }
};

module.exports.resolveSession = resolveSession;
