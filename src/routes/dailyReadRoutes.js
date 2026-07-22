// src/routes/dailyReadRoutes.js
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const auth = require("../middleware/auth");
const DailyRead = require("../models/DailyRead"); // ✅ Synced matching collection model filename lookup

// 🗓️ UTC day-key helper — same "YYYY-MM-DD" convention User.engagementHistory
// uses for streak entries, so "today" means the same calendar day across
// both features regardless of the server's local timezone.
const todayUtcKey = () => new Date().toISOString().split("T")[0];

// 🏢 Shared department-scope resolver — superadmins see/manage everything
// (or a specific department via a client-supplied id, since they have none
// of their own); a plain admin is always locked to req.user.department,
// never a client-supplied value. Mirrors the logic this file already had
// duplicated across every GET route.
function resolveDeptScope(req, { targetDepartmentId } = {}) {
  const isSuperAdmin = req.user.role === "superadmin";
  if (isSuperAdmin) {
    if (!targetDepartmentId) return { isSuperAdmin, department: null, error: null };
    return { isSuperAdmin, department: new mongoose.Types.ObjectId(targetDepartmentId.toString()), error: null };
  }
  if (!req.user.department) {
    return { isSuperAdmin, department: null, error: "Tenant Error: User context has no assigned department." };
  }
  return { isSuperAdmin, department: new mongoose.Types.ObjectId(req.user.department.toString()), error: null };
}

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
          message: "Validation Error: Superadmins must provide a targetDepartmentId since Global streams are disabled.",
        });
      }
      assignedDepartment = new mongoose.Types.ObjectId(targetDepartmentId.toString());
    } else {
      // Standard Admin is bound directly to their own session department context block
      if (!req.user.department) {
        return res.status(400).json({
          success: false,
          message: "Profile Exception: Admin user has no designated department context mapped.",
        });
      }
      assignedDepartment = new mongoose.Types.ObjectId(req.user.department.toString());
    }

    const dateKey = todayUtcKey();

    // 🔒 One Daily Read per department per day — check before insert so we can
    // return a clear, actionable message instead of a raw duplicate-key error.
    const existingToday = await DailyRead.findOne({ department: assignedDepartment, dateKey });
    if (existingToday) {
      return res.status(409).json({
        success: false,
        message: "A Daily Read has already been posted today for this department. Edit or delete it instead of creating a new one.",
      });
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
      dateKey,
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

// ✏️ 2. UPDATE TODAY'S DAILY READ (Owning Admin & Superadmin Only)
// =========================================================================
router.put("/admin/daily-reads/:id", auth, async (req, res) => {
  if (req.user.role !== "admin" && req.user.role !== "superadmin") {
    return res.status(403).json({ success: false, message: "Access Denied: Administrative Clearance Required." });
  }

  try {
    const existing = await DailyRead.findById(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, message: "Daily Read article not found." });
    }

    const isSuperAdmin = req.user.role === "superadmin";
    if (!isSuperAdmin) {
      if (!req.user.department || existing.department.toString() !== req.user.department.toString()) {
        return res.status(403).json({ success: false, message: "Forbidden: This Daily Read belongs to a different department." });
      }
    }

    if (existing.dateKey !== todayUtcKey()) {
      return res.status(403).json({ success: false, message: "Only today's Daily Read can be edited. Past posts are locked archive." });
    }

    const { title, content, imageUrl, referenceLink, tags } = req.body;
    if (title !== undefined) existing.title = title.trim();
    if (content !== undefined) existing.content = content.trim();
    if (imageUrl !== undefined) existing.imageUrl = imageUrl;
    if (referenceLink !== undefined) existing.referenceLink = referenceLink;
    if (tags !== undefined) existing.tags = tags;
    existing.updatedAt = new Date();

    await existing.save();

    res.json({ success: true, message: "Daily Read article updated.", data: existing });
  } catch (err) {
    console.error("❌ Update Daily Read Processing Crash:", err.message);
    res.status(500).json({ success: false, message: `Server Error: ${err.message}` });
  }
});

// 🗑️ 3. DELETE TODAY'S DAILY READ (Owning Admin & Superadmin Only)
// =========================================================================
router.delete("/admin/daily-reads/:id", auth, async (req, res) => {
  if (req.user.role !== "admin" && req.user.role !== "superadmin") {
    return res.status(403).json({ success: false, message: "Access Denied: Administrative Clearance Required." });
  }

  try {
    const existing = await DailyRead.findById(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, message: "Daily Read article not found." });
    }

    const isSuperAdmin = req.user.role === "superadmin";
    if (!isSuperAdmin) {
      if (!req.user.department || existing.department.toString() !== req.user.department.toString()) {
        return res.status(403).json({ success: false, message: "Forbidden: This Daily Read belongs to a different department." });
      }
    }

    if (existing.dateKey !== todayUtcKey()) {
      return res.status(403).json({ success: false, message: "Only today's Daily Read can be deleted. Past posts are locked archive." });
    }

    await existing.deleteOne();

    res.json({ success: true, message: "Daily Read article deleted." });
  } catch (err) {
    console.error("❌ Delete Daily Read Processing Crash:", err.message);
    res.status(500).json({ success: false, message: `Server Error: ${err.message}` });
  }
});

// 📖 4. GET TODAY'S READ (For Employee Dashboard Home - Strict Multi-Tenant Filter)
// =========================================================================
router.get("/todays-read", auth, async (req, res) => {
  try {
    const { department, error } = resolveDeptScope(req);
    if (error) return res.status(400).json({ success: false, message: error });

    const isSuperAdmin = req.user.role === "superadmin";
    const visibilityQuery = isSuperAdmin ? {} : { department };

    // Find today's article matching strict target scope criteria
    const todaysRead = await DailyRead.findOne({
      ...visibilityQuery,
      dateKey: todayUtcKey(),
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

// 📚 5. GET ALL ACCESSIBLE READS (History/Archive Feed)
// =========================================================================
router.get("/all-reads", auth, async (req, res) => {
  try {
    const isSuperAdmin = req.user.role === "superadmin";

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

// 📅 6. GET A SPECIFIC DATE'S READ (Calendar click-through)
// =========================================================================
router.get("/by-date/:dateKey", auth, async (req, res) => {
  try {
    const { department, error } = resolveDeptScope(req, { targetDepartmentId: req.query.departmentId });
    if (error) return res.status(400).json({ success: false, message: error });

    const isSuperAdmin = req.user.role === "superadmin";
    if (isSuperAdmin && !department) {
      return res.status(400).json({ success: false, message: "Superadmins must provide a departmentId query param." });
    }

    const read = await DailyRead.findOne({ department, dateKey: req.params.dateKey });
    res.json({ success: true, data: read || null });
  } catch (err) {
    console.error("❌ Fetch Daily Read By Date Fault:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
