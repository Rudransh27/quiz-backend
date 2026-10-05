// src/routes/authActivityRoutes.js  (mounted at /api/admin/auth)
//
// Admin view of sign-in activity (models/AuthEvent.js) and sessions
// (models/AuthSession.js). Never returns secrets or identity-provider
// claims. A department admin sees users of their own department; a
// superadmin sees everyone, plus IP addresses and failed attempts that
// matched no account.
//   GET  /events?userId=&type=&method=&result=&from=&to=&q=&page=&limit=&format=csv
//   GET  /users/:userId/sessions          active sessions + last sign-in
//   POST /users/:userId/sessions/revoke   end all of that user's sessions
const express = require("express");
const auth = require("../middleware/auth");
const admin = require("../middleware/admin");
const User = require("../models/User");
const AuthEvent = require("../models/AuthEvent");
const AuthSession = require("../models/AuthSession");
const { endUserSessions } = require("../services/auth/sessions");
const { signInMethods } = require("../services/auth/identity");
const { METHODS } = require("../services/auth/providers");
const { buildCsv } = require("../utils/csvBuilder");
const { handleError } = require("../utils/safeError");

const router = express.Router();
const isId = (v) => /^[a-f0-9]{24}$/i.test(String(v || ""));
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isSuper = (req) => req.user.role === "superadmin";

// "Chrome on Windows" from a user-agent string — enough to tell devices
// apart without showing the raw string.
function deviceOf(ua) {
  if (!ua) return "";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Chrome\//.test(ua) ? "Chrome"
    : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Windows/.test(ua) ? "Windows" : /iPhone|iPad|iOS/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android"
    : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

// The user ids this admin may see, or null for "everyone" (superadmin).
async function scopedUserIds(req) {
  if (isSuper(req)) return null;
  if (!req.user.department) return [];
  const users = await User.find({ department: req.user.department }, "_id").lean();
  return users.map((u) => u._id);
}

async function loadTarget(req, userId) {
  if (!isId(userId)) return { error: [400, "Invalid user id."] };
  const user = await User.findById(userId, "username email role department lastLoginAt lastLoginMethod lastLoginProvider microsoftId").lean();
  if (!user) return { error: [404, "User not found."] };
  if (!isSuper(req) && !(req.user.department && user.department && String(user.department) === String(req.user.department))) {
    return { error: [403, "This user is outside your department."] };
  }
  return { user };
}

router.get("/events", [auth, admin], async (req, res) => {
  try {
    const q = req.query;
    const filter = {};
    const scope = await scopedUserIds(req);
    let userFilter = scope; // null = no restriction

    if (isId(q.userId)) {
      if (scope && !scope.some((id) => String(id) === String(q.userId))) return res.status(403).json({ success: false, message: "This user is outside your department." });
      userFilter = [q.userId];
    }
    if (typeof q.q === "string" && q.q.trim()) {
      const re = new RegExp(escapeRegex(q.q.trim().slice(0, 80)), "i");
      const match = await User.find({ $or: [{ username: re }, { email: re }], ...(scope ? { _id: { $in: scope } } : {}) }, "_id").limit(500).lean();
      const ids = match.map((u) => u._id);
      userFilter = userFilter ? ids.filter((id) => userFilter.some((u) => String(u) === String(id))) : ids;
      if (isSuper(req)) filter.$or = [{ user_id: { $in: userFilter } }, { user_id: null, email: re }];
    }
    if (userFilter && !filter.$or) filter.user_id = { $in: userFilter };

    if (AuthEvent.TYPES.includes(q.type)) filter.type = q.type;
    if (METHODS.includes(q.method)) filter.method = q.method;
    if (q.result === "success") filter.success = true;
    if (q.result === "failure") filter.success = false;
    const from = q.from ? new Date(q.from) : null;
    const to = q.to ? new Date(q.to) : null;
    if ((from && !Number.isNaN(+from)) || (to && !Number.isNaN(+to))) {
      filter.createdAt = {};
      if (from && !Number.isNaN(+from)) filter.createdAt.$gte = from;
      if (to && !Number.isNaN(+to)) filter.createdAt.$lte = to;
    }

    const csv = q.format === "csv";
    const limit = csv ? 5000 : Math.min(Math.max(Number(q.limit) || 50, 1), 200);
    const page = csv ? 1 : Math.max(Number(q.page) || 1, 1);
    const [events, total, summary] = await Promise.all([
      AuthEvent.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      AuthEvent.countDocuments(filter),
      AuthEvent.aggregate([
        { $match: filter },
        { $group: { _id: null, success: { $sum: { $cond: ["$success", 1, 0] } }, failed: { $sum: { $cond: ["$success", 0, 1] } },
          sso: { $sum: { $cond: [{ $and: [{ $eq: ["$type", "LOGIN_SUCCESS"] }, { $eq: ["$method", "SSO"] }] }, 1, 0] } },
          local: { $sum: { $cond: [{ $and: [{ $eq: ["$type", "LOGIN_SUCCESS"] }, { $eq: ["$method", "LOCAL"] }] }, 1, 0] } } } },
      ]),
    ]);

    const people = await User.find({ _id: { $in: [...new Set(events.flatMap((e) => [e.user_id, e.actor_id]).filter(Boolean).map(String))] } }, "username email").lean();
    const who = new Map(people.map((u) => [String(u._id), u]));
    const showIp = isSuper(req);
    const rows = events.map((e) => {
      const u = e.user_id ? who.get(String(e.user_id)) : null;
      return {
        _id: e._id,
        at: e.createdAt,
        type: e.type,
        method: e.method,
        provider: e.provider,
        success: e.success,
        reason: e.reason,
        user: u ? { _id: String(u._id), username: u.username, email: u.email } : null,
        email: u ? u.email : e.email,
        actor: e.actor_id ? who.get(String(e.actor_id))?.username || "" : "",
        device: deviceOf(e.userAgent),
        ip: showIp ? e.ip : undefined,
      };
    });

    if (csv) {
      const headers = ["Time (UTC)", "User", "Email", "Method", "Provider", "Event", "Result", "Reason", "Device", ...(showIp ? ["IP"] : [])];
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="sign-in-activity.csv"');
      return res.status(200).send(buildCsv(headers, rows.map((r) => [
        new Date(r.at).toISOString(), r.user?.username || "", r.email || "", r.method || "", r.provider || "", r.type,
        r.success ? "Success" : "Failure", r.reason || "", r.device, ...(showIp ? [r.ip || ""] : []),
      ])));
    }
    const s = summary[0] || { success: 0, failed: 0, sso: 0, local: 0 };
    return res.json({ success: true, data: rows, total, page, limit, summary: { total, success: s.success, failed: s.failed, ssoLogins: s.sso, localLogins: s.local } });
  } catch (err) { return handleError(res, err, 500); }
});

router.get("/users/:userId/sessions", [auth, admin], async (req, res) => {
  try {
    const { user, error } = await loadTarget(req, req.params.userId);
    if (error) return res.status(error[0]).json({ success: false, message: error[1] });
    const sessions = await AuthSession.find({ user_id: user._id, endedAt: null, expiresAt: { $gt: new Date() } })
      .sort({ lastSeenAt: -1 }).lean();
    const showIp = isSuper(req);
    return res.json({
      success: true,
      data: {
        lastLoginAt: user.lastLoginAt || null,
        lastLoginMethod: user.lastLoginMethod || null,
        lastLoginProvider: user.lastLoginProvider || null,
        signInMethods: await signInMethods(user),
        sessions: sessions.map((s) => ({
          ref: s.sessionId.slice(-6),
          method: s.method,
          provider: s.provider,
          device: deviceOf(s.userAgent),
          ip: showIp ? s.ip : undefined,
          startedAt: s.createdAt,
          lastSeenAt: s.lastSeenAt,
          expiresAt: s.expiresAt,
          current: s.sessionId === req.user.sessionId,
        })),
      },
    });
  } catch (err) { return handleError(res, err, 500); }
});

router.post("/users/:userId/sessions/revoke", [auth, admin], async (req, res) => {
  try {
    const { user, error } = await loadTarget(req, req.params.userId);
    if (error) return res.status(error[0]).json({ success: false, message: error[1] });
    if (!isSuper(req) && user.role !== "user") {
      return res.status(403).json({ success: false, message: "Only a superadmin can end an admin's sessions." });
    }
    const ended = await endUserSessions(user._id, "revoked", { req, actorId: req.user.id });
    return res.json({ success: true, data: { ended } });
  } catch (err) { return handleError(res, err, 500); }
});

module.exports = router;
module.exports.deviceOf = deviceOf;
