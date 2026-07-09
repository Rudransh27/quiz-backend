// src/routes/departmentRoutes.js
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

// 🧠 Points cleanly to your actual Department model file
const Department = require("../models/Department"); 

// 🔒 Security Guards Import
const auth = require("../middleware/auth");
const admin = require("../middleware/admin");

// =========================================================================
// @route    GET /api/departments/public
// @desc     Get all department contexts with virtual populated child teams
// @access   Public (No token needed - Used for registration dropdown sync)
// =========================================================================
router.get("/public", async (req, res) => {
  try {
    console.log("📡 Fetching active multi-tenant cluster structural layout...");

    // ⚡ .populate('teams') dynamically runs the reverse virtual lookup defined in your Department schema
    // It selects only the necessary fields (_id name code) to keep payload packets lightweight
    const structure = await Department.find({})
      .populate({
        path: "teams",
        select: "name code _id" 
      });
      
    return res.status(200).json(structure);
  } catch (err) {
    console.error("❌ Public Department Structure Fetch Failure:", err.message);
    return res.status(500).json({ 
      success: false, 
      message: "Failed to load system corporate departments and nested teams dynamically." 
    });
  }
});

// =========================================================================
// @route    POST /api/departments
// @desc     Create a fresh corporate department entity asset
// @access   Private (Superadmin/Admin Only)
// =========================================================================
router.post("/", [auth, admin], async (req, res) => {
  const { name, code, description } = req.body;

  if (!name || !code) {
    return res.status(400).json({ 
      success: false, 
      message: "Please provide both department name and standardized code string." 
    });
  }

  try {
    // Guard: Prevent duplicate code configurations
    const normalizedCode = code.trim().toLowerCase();
    const existingDept = await Department.findOne({ code: normalizedCode });
    
    if (existingDept) {
      return res.status(400).json({ 
        success: false, 
        message: `A department configuration with code '${normalizedCode}' already exists.` 
      });
    }

    const newDepartment = new Department({
      name: name.trim(),
      code: normalizedCode,
      description: description ? description.trim() : ""
    });

    await newDepartment.save();
    return res.status(201).json({ 
      success: true, 
      data: newDepartment 
    });
  } catch (err) {
    console.error("❌ Admin Department Creation Exception:", err.message);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

module.exports = router;