const express = require('express');
const router = express.Router();
const mongoose = require('mongoose'); 
const User = require('../models/User');
const auth = require('../middleware/auth'); 

// =========================================================================
// @route   GET /api/users/count-verified
// @desc    Get verified users count (Superadmin = System Total, Admin = Their Department Only)
// @access  Private (Authenticated Admins/Superadmins Only)
// =========================================================================
router.get('/count-verified', auth, async (req, res) => {
  // 🛡️ ROLE CHECK: Enforce strict administrative clearance loops
  if (req.user.role !== 'admin' && req.user.role !== 'superadmin') {
    return res.status(403).json({ success: false, message: "Access Denied: Administrative privilege required." });
  }

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

    return res.json({ success: true, data: rankedLeaderboard });
  } catch (err) {
    console.error("Leaderboard Aggregation Failure:", err.message);
    return res.status(500).json({ message: "Internal server error reading rankings." });
  }
});

module.exports = router;