// src/routes/teamRoutes.js
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const Team = require("../models/Team");
const Department = require("../models/Department");

// 🔒 Security Guards Import
const auth = require("../middleware/auth");
const admin = require("../middleware/admin");

// =========================================================================
// @route    GET /api/teams/:departmentId
// @desc     Fetch all teams belonging to a specific department
// @access   Private (Authenticated Users/Admins)
// =========================================================================
router.get("/:departmentId", auth, async (req, res) => {
  const { departmentId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(departmentId)) {
    return res.status(400).json({ success: false, message: "Invalid Department ID format." });
  }

  try {
    const teams = await Team.find({ department_id: departmentId }).select("_id name code");
    return res.status(200).json(teams);
  } catch (err) {
    console.error("❌ Fetch Teams Failure:", err.message);
    return res.status(500).json({ success: false, message: "Server Error: Failed to load teams." });
  }
});

// =========================================================================
// @route    POST /api/teams
// @desc     Create a new sub-team scope under a specific department parent
// @access   Private (Superadmin/Department Admin Only)
// =========================================================================
router.post("/", [auth, admin], async (req, res) => {
  const { name, code, departmentId } = req.body;

  if (!name || !code || !departmentId) {
    return res.status(400).json({ 
      success: false, 
      message: "Please provide team name, unique code, and parent departmentId." 
    });
  }

  if (!mongoose.Types.ObjectId.isValid(departmentId)) {
    return res.status(400).json({ success: false, message: "Invalid parent departmentId format." });
  }

  try {
    // 🛡️ Hierarchy Check: Ensure the target parent department actually exists
    const parentDept = await Department.findById(departmentId);
    if (!parentDept) {
      return res.status(404).json({ success: false, message: "Parent department not found." });
    }

    const normalizedCode = code.trim().toUpperCase();

    // 🛡️ Duplicate Guard: Ensure the team code doesn't already exist under this specific department
    const existingTeam = await Team.findOne({ department_id: departmentId, code: normalizedCode });
    if (existingTeam) {
      return res.status(400).json({ 
        success: false, 
        message: `A team configuration with code '${normalizedCode}' already exists inside this department.` 
      });
    }

    const newTeam = new Team({
      name: name.trim(),
      code: normalizedCode,
      department_id: departmentId
    });

    await newTeam.save();
    return res.status(201).json({ success: true, data: newTeam });

  } catch (err) {
    console.error("❌ Admin Team Creation Exception:", err.message);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

module.exports = router;