const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const User = require('../models/User');
const Region = require('../models/Region');
const auth = require('../middleware/auth');
const admin = require('../middleware/admin');
const { checkAndAwardBadges, getOrbitTier, getLast7Days, getMyDepartmentRank } = require('../utils/achievements');

// =========================================================================
// @route   GET /api/users/count-verified
// @desc    Get verified users count (Superadmin = System Total, Admin = Their Department Only)
// @access  Private (Authenticated Admins/Superadmins Only)
// =========================================================================
router.get('/count-verified', [auth, admin], async (req, res) => {
  try {
    const isSuperAdmin = req.user.role === 'superadmin';
    const adminDepartmentId = req.user.department;
    
    // Read optional team filtering parameters from the request query string
    const { teamId } = req.query;

    // 🧠 DYNAMIC QUERY FILTER MATRIX
    const queryCriteria = { isVerified: true };

    // IF NOT SUPERADMIN: Strict multi-tenant operational boundary checks lock
    if (!isSuperAdmin) {
      if (!adminDepartmentId) {
        return res.status(400).json({ success: false, message: "Validation Error: Admin profile missing department mapping link." });
      }
      
      // Explicitly cast to authentic formatted Mongoose ObjectId wrapper 
      queryCriteria.department = new mongoose.Types.ObjectId(adminDepartmentId.toString());
    } else {
      // If Superadmin and a specific department query context is passed from the dashboard view selection
      if (req.query.departmentId && mongoose.Types.ObjectId.isValid(req.query.departmentId)) {
        queryCriteria.department = new mongoose.Types.ObjectId(req.query.departmentId.toString());
      }
    }

    // 👥 NEW THREE-LAYER TEAM FILTERING STEP
    // If a teamId filter parameter is passed, apply it safely after validating its format
    if (teamId) {
      if (mongoose.Types.ObjectId.isValid(teamId)) {
        queryCriteria.team = new mongoose.Types.ObjectId(teamId.toString());
      } else {
        return res.status(400).json({ success: false, message: "Validation Error: Invalid teamId parameter format." });
      }
    }

    // Fetch the final calculated count instantly via safe indexing filters
    const verifiedUsersCount = await User.countDocuments(queryCriteria);
    
    console.log(`📊 Secure Analytics Log - Role: ${req.user.role} | Count Compiled: ${verifiedUsersCount} | Criteria:`, queryCriteria);
    
    return res.status(200).json({ success: true, count: verifiedUsersCount });
  } catch (error) {
    console.error("❌ High-scale users metrics telemetry failed:", error.message);
    return res.status(500).json({ success: false, message: "Internal server infrastructure telemetry error" });
  }
});

// =========================================================================
// 🏆 GET /api/users/department-leaderboard
// @desc    Get top ranked users matching the requester's department context
// =========================================================================
router.get("/department-leaderboard", auth, async (req, res) => {
  try {
    const contextUser = req.user.user ? req.user.user : req.user;
    const userDepartmentId = contextUser.department;

    if (!userDepartmentId) {
      return res.status(400).json({ success: false, message: "User department context is missing." });
    }

    // Query for verified users in the same department, sorted by highest XP
    const topPerformers = await User.find({ department: userDepartmentId, isVerified: true })
      .select("username xp profileImageUrl")
      .sort({ xp: -1 })
      .limit(10)
      .lean();

    // Map the records to fit the frontend avatar/ranking properties cleanly
    const rankedLeaderboard = topPerformers.map((player, idx) => {
      const rank = idx + 1;
      let rankClass = "plain";
      if (rank === 1) rankClass = "gold";
      if (rank === 2) rankClass = "silver";
      if (rank === 3) rankClass = "bronze";

      return {
        rank,
        name: player.username,
        xp: player.xp || 0,
        avatar: player.username ? player.username.substring(0, 2).toUpperCase() : "TR",
        class: rankClass,
        userId: player._id.toString()
      };
    });

    // 🎯 The requester's own rank/xp, computed even when they're outside the
    // top 10 — the profile page's leaderboard-rank teaser needs this and
    // shouldn't require scanning the whole department client-side. The JWT
    // payload (contextUser) doesn't carry xp, so the real DB record is
    // needed here, not the token's own department-only fields.
    const me = await User.findById(contextUser.id, "xp department").lean();
    const myRank = me ? await getMyDepartmentRank(me) : null;

    return res.json({
      success: true,
      data: rankedLeaderboard,
      myRank,
      myXp: me?.xp || 0,
    });
  } catch (err) {
    console.error("Leaderboard Aggregation Failure:", err.message);
    return res.status(500).json({ message: "Internal server error reading rankings." });
  }
});

// =========================================================================
// 🏅 GET /api/users/me/gamification
// @desc    Badges (evaluated + lazily awarded), Your Orbit XP tier, and the
//          7-day streak-calendar strip — one call for the Profile page.
// =========================================================================
router.get("/me/gamification", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    const [badges] = await Promise.all([checkAndAwardBadges(req.user.id)]);
    const orbitTier = getOrbitTier(user.xp || 0);
    const last7Days = getLast7Days(user);

    return res.json({ success: true, data: { badges, orbitTier, last7Days } });
  } catch (err) {
    console.error("Gamification Summary Failure:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error computing gamification summary." });
  }
});

// =========================================================================
// 🌍 PUT /api/users/:id/regions
// @desc    Set which regions a user is scoped to — the same field a learner
//          can self-manage from their own profile (UserProfile.jsx), but
//          settable here by an admin/superadmin on someone ELSE's account.
//          Department Admins may only touch users in their own department
//          (same convention as GET /api/progress/admin/users' roster);
//          Superadmin may target anyone. Silently drops any submitted id
//          that isn't a real Region — region assignment is meant to be
//          forgiving, never a hard validation failure (mirrors
//          authRoutes.js's resolveRegionIds).
// @access  Private (Admin / Superadmin)
// =========================================================================
router.put('/:id/regions', [auth, admin], async (req, res) => {
  try {
    const target = await User.findById(req.params.id);
    if (!target) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    if (req.user.role !== 'superadmin') {
      const sameDept = req.user.department && target.department
        && req.user.department.toString() === target.department.toString();
      if (!sameDept) {
        return res.status(403).json({ success: false, message: 'Access Denied: You can only manage users in your own department.' });
      }
    }

    const { regions } = req.body;
    const list = Array.isArray(regions) ? regions : (regions ? [regions] : []);
    const validIds = list
      .map((v) => (v && v._id ? v._id : v))
      .filter((v) => v && mongoose.Types.ObjectId.isValid(v.toString()));
    const found = validIds.length > 0
      ? await Region.find({ _id: { $in: validIds } }, 'name code color').lean()
      : [];

    target.regions = found.map((r) => r._id);
    await target.save();

    return res.json({ success: true, data: { _id: target._id, regions: found } });
  } catch (err) {
    console.error('Assign user regions error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;