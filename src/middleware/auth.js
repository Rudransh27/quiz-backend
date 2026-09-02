// src/middleware/auth.js
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const User = require('../models/User');

module.exports = async function (req, res, next) {
  const token = req.header('Authorization');

  if (!token) {
    return res.status(401).json({ message: 'No token, authorization denied' });
  }

  try {
    const cleanToken = token.replace('Bearer ', '');
    // Pin the accepted algorithm so a tampered/forged token using a
    // different alg (e.g. "none") is rejected outright by the library,
    // rather than relying on the caller to have configured this correctly.
    const decoded = jwt.verify(cleanToken, process.env.JWT_SECRET, { algorithms: ['HS256'] });

    const contextUser = decoded.user ? decoded.user : decoded;

    // 🔐 SESSION-BINDING CHECK — a syntactically valid JWT for a real,
    // currently-privileged account is NOT enough on its own: it must also
    // arrive with the HttpOnly cookie issued to the same browser at login
    // (see authRoutes.js's issueBindingCookie). This is what stops a token
    // captured in a proxy (Burp) from one session and pasted into another
    // session's Authorization header — the pasted-into session never
    // received that session's binding cookie, so the hashes won't match
    // even though the token itself verifies perfectly fine.
    const bindingSecret = req.cookies ? req.cookies.orbit_bind : undefined;
    if (!contextUser.bh || !bindingSecret) {
      return res.status(401).json({ message: 'Session is not valid from this browser context. Please log in again.' });
    }
    const bindingHash = crypto.createHash('sha256').update(bindingSecret).digest('hex');
    if (bindingHash !== contextUser.bh) {
      console.warn(`🚨 SESSION BINDING MISMATCH: a token for user ${contextUser.id} was presented without its matching browser session — likely token theft/replay.`);
      return res.status(401).json({ message: 'Session is not valid from this browser context. Please log in again.' });
    }

    // Privilege/scope must be re-derived from the current database record on
    // every request, never trusted from the token payload — the JWT's claims
    // are frozen at login time (tokens live up to 24h), so an admin/superadmin
    // demotion, account deactivation, or a leaked/replayed token would
    // otherwise keep granting the ROLE BAKED IN AT ISSUANCE regardless of
    // what the account is actually authorized for right now.
    const dbUser = await User.findById(contextUser.id).select('role department team regions username');

    if (!dbUser) {
      return res.status(401).json({ message: 'Token is not valid' });
    }

    req.user = {
      id: dbUser._id,
      role: dbUser.role,
      username: dbUser.username,
      sessionId: contextUser.sessionId,
      department: dbUser.department || null,
      team: dbUser.team || null,
      regions: dbUser.regions || [],
    };

    // REDIS SINGLE LOGIN ENFORCEMENT CHECKER
    if (global.redisClient && global.redisClient.isOpen && global.redisClient.isReady && req.user.sessionId) {
      const activeValidSessionId = await global.redisClient.get(`session:${req.user.id.toString()}`);

      if (!activeValidSessionId || activeValidSessionId !== req.user.sessionId) {
        console.warn(`🚨 MULTI-LOGIN DETECTED: Revoking server access for User: ${req.user.id}`);
        return res.status(401).json({ 
          message: 'Security Alert: Your session has been terminated because this account logged in on another machine/browser.' 
        });
      }
      
      await global.redisClient.expire(`session:${req.user.id.toString()}`, 86400);
    }

    next();
  } catch (err) {
    console.error("❌ Auth Token Validation Failure:", err.message);
    res.status(401).json({ message: 'Token is not valid' });
  }
};