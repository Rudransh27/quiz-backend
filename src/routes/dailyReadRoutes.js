// src/routes/dailyReadRoutes.js
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const auth = require("../middleware/auth");
const DailyRead = require("../models/DailyRead"); // ✅ Synced matching collection model filename lookup

// 📝 1. POST A DAILY READ (Admin & Superadmin Only API)
// =========================================================================
router.post("/admin/daily-reads", auth, async (req, res) => {
  // Allow both 'admin' and 'superadmin' roles to access posting privileges cleanly
  if (req.user.role !== "admin" && req.user.role !== "superadmin") {
    return res
      .status(403)
      .json({ success: false, message: "Access Denied: Administrative Clearance Required." });
  }

  // 🚀 INJECTED: superadmin must supply a target departmentId in the body since global is dead
  const { title, content, imageUrl, referenceLink, tags, targetDepartmentId } = req.body;
  
  try {
    const isSuperAdmin = req.user.role === "superadmin";
    let assignedDepartment;

    if (isSuperAdmin) {
      if (!targetDepartmentId) {
        return res.status(400).json({ 
          success: false, 
          message: "Validation Error: Superadmins must provide a targetDepartmentId since Global streams are disabled." 
        });
      }
      assignedDepartment = new mongoose.Types.ObjectId(targetDepartmentId.toString());
    } else {
      // Standard Admin is bound directly to their own session department context block
      if (!req.user.department) {
        return res.status(400).json({ 
          success: false, 
          message: "Profile Exception: Admin user has no designated department context mapped." 
        });
      }
      assignedDepartment = new mongoose.Types.ObjectId(req.user.department.toString());
    }

    const newRead = new DailyRead({
      title: title.trim(),
      content: content.trim(),
      imageUrl,
      referenceLink,
      tags,
      visibility: "Departmental", // ✅ Forcing absolute departmental single-tier configuration flag
      department: assignedDepartment, 
      postedBy: req.user.id || req.user._id,
    });

    await newRead.save();
    
    res.status(201).json({
      success: true,
      message: "Daily Read article posted uniformly inside corporate department stream!",
      data: newRead,
    });
  } catch (err) {
    console.error("❌ Post Daily Read Processing Crash:", err.message);
    res.status(500).json({ success: false, message: `Server Error: ${err.message}` });
  }
});

// 📖 2. GET TODAY'S READ (For Employee Dashboard Home - Strict Multi-Tenant Filter)
// =========================================================================
router.get("/todays-read", auth, async (req, res) => {
  try {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const isSuperAdmin = req.user.role === "superadmin";

    // 🧠 REFACTORED SaaS SECURITY MATRIX:
    // Superadmins can read all articles across the grid. Standard employees see ONLY their target department.
    // [null] checks are completely dropped to protect data walls.
    let visibilityQuery = {};
    if (!isSuperAdmin) {
      if (!req.user.department) {
        return res.status(400).json({ success: false, message: "Tenant Error: User context has no assigned department." });
      }
      visibilityQuery = { department: new mongoose.Types.ObjectId(req.user.department.toString()) };
    }

    // Find today's latest article matching strict target scope criteria
    const todaysRead = await DailyRead.findOne({
      ...visibilityQuery,
      createdAt: { $gte: startOfToday },
    }).sort({ createdAt: -1 });

    if (!todaysRead) {
      // Fallback: Get the latest authorized article matching the secure department scope
      const latestFallback = await DailyRead.findOne(visibilityQuery).sort({ createdAt: -1 });
      return res.json({ success: true, data: latestFallback });
    }

    res.json({ success: true, data: todaysRead });
  } catch (err) {
    console.error("❌ Fetch Today's Read Fault:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// 📚 3. GET ALL ACCESSIBLE READS (History/Archive Feed)
// =========================================================================
router.get("/all-reads", auth, async (req, res) => {
  try {
    const isSuperAdmin = req.user.role === "superadmin";

    // 🚀 REFACTORED: Stripped old global fallback null options out of the collection lookup pipes
    let visibilityQuery = {};
    if (!isSuperAdmin) {
      if (!req.user.department) {
        return res.status(400).json({ success: false, message: "Tenant Error: User context has no assigned department." });
      }
      visibilityQuery = { department: new mongoose.Types.ObjectId(req.user.department.toString()) };
    }

    const allReads = await DailyRead.find(visibilityQuery).sort({ createdAt: -1 });
    res.json({ success: true, data: allReads });
  } catch (err) {
    console.error("❌ Fetch All Reads Pipeline Crash:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;