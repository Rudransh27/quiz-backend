// src/middleware/superadmin.js
// Stricter sibling of middleware/admin.js — no department-admin bypass at
// all. Used for cross-department comparison endpoints (Platform Analytics'
// module-engagement and department-stats) where there is no sensible
// single-department scoping to fall back to.
module.exports = function (req, res, next) {
  if (req.user?.role === 'superadmin') {
    return next();
  }
  return res.status(403).json({ success: false, message: 'Forbidden: Superadmin access only.' });
};
