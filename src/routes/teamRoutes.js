// src/routes/teamRoutes.js
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const Team = require("../models/Team");
const Department = require("../models/Department");
const User = require("../models/User");
const TeamTransferRequest = require("../models/TeamTransferRequest");
const UserNotification = require("../models/UserNotification");

// 🔒 Security Guards Import
const auth = require("../middleware/auth");
const admin = require("../middleware/admin");

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

// =========================================================================
// @route    GET /api/teams/hub/:departmentId
// @desc     Team Hub overview — every team in the department, each with its
//           admin(s), member roster, and top performer. Any admin in the
//           department can view this (not just admins of a specific team) —
//           it's a read, and reads have always been department-wide here.
// @access   Private (Admin/Superadmin)
// =========================================================================
router.get("/hub/:departmentId", [auth, admin], async (req, res) => {
  const { departmentId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(departmentId)) {
    return res.status(400).json({ success: false, message: "Invalid Department ID format." });
  }

  const isSuperAdmin = req.user.role === "superadmin";
  if (!isSuperAdmin && (!req.user.department || req.user.department.toString() !== departmentId)) {
    return res.status(403).json({ success: false, message: "Forbidden: you can only view your own department's Team Hub." });
  }

  try {
    const teams = await Team.find({ department_id: departmentId }).sort({ isCouncil: -1, name: 1 }).lean();
    const teamIds = teams.map((t) => t._id);

    const allUsers = await User.find(
      { team: { $in: teamIds } },
      "username avatarUrl xp role team"
    ).lean();

    const usersByTeam = new Map();
    allUsers.forEach((u) => {
      const key = u.team.toString();
      if (!usersByTeam.has(key)) usersByTeam.set(key, []);
      usersByTeam.get(key).push(u);
    });

    const hub = teams.map((team) => {
      const roster = usersByTeam.get(team._id.toString()) || [];
      const admins = roster.filter((u) => u.role === "admin" || u.role === "superadmin");
      const members = roster.filter((u) => u.role === "user");
      // "Top performer" compares peers — highest-XP learner on the team,
      // not the admin(s) themselves.
      const topPerformer = members.length
        ? members.reduce((best, u) => (u.xp > (best?.xp || -1) ? u : best), null)
        : null;

      return {
        _id: team._id,
        name: team.name,
        code: team.code,
        isCouncil: team.isCouncil,
        admins: admins.map((a) => ({ _id: a._id, username: a.username, avatarUrl: a.avatarUrl, xp: a.xp })),
        members: members.map((m) => ({ _id: m._id, username: m.username, avatarUrl: m.avatarUrl, xp: m.xp })),
        memberCount: members.length,
        topPerformer: topPerformer
          ? { _id: topPerformer._id, username: topPerformer.username, xp: topPerformer.xp, avatarUrl: topPerformer.avatarUrl }
          : null,
      };
    });

    return res.status(200).json({ success: true, teams: hub });
  } catch (err) {
    console.error("❌ Team Hub Fetch Failure:", err.message);
    return res.status(500).json({ success: false, message: "Server Error: Failed to load Team Hub." });
  }
});

// =========================================================================
// @route    POST /api/teams/transfer-request
// @desc     Move a member from their current team to another team in the
//           SAME department. If the target team has an admin, this becomes
//           a pending request that admin must approve; if the target team
//           has no admin, the move happens immediately.
// @access   Private (Admin/Superadmin)
// =========================================================================
router.post("/transfer-request", [auth, admin], async (req, res) => {
  const { userId, toTeamId } = req.body;

  if (!userId || !toTeamId || !mongoose.Types.ObjectId.isValid(userId) || !mongoose.Types.ObjectId.isValid(toTeamId)) {
    return res.status(400).json({ success: false, message: "userId and toTeamId are required." });
  }

  try {
    const targetUser = await User.findById(userId, "department team");
    if (!targetUser) return res.status(404).json({ success: false, message: "User not found." });
    if (!targetUser.team) {
      return res.status(400).json({ success: false, message: "This user isn't assigned to a team yet — nothing to transfer from." });
    }

    const toTeam = await Team.findById(toTeamId);
    if (!toTeam) return res.status(404).json({ success: false, message: "Target team not found." });

    const isSuperAdmin = req.user.role === "superadmin";
    if (!isSuperAdmin) {
      const adminDept = req.user.department ? req.user.department.toString() : null;
      if (!adminDept || targetUser.department.toString() !== adminDept || toTeam.department_id.toString() !== adminDept) {
        return res.status(403).json({ success: false, message: "Forbidden: you can only reassign members within your own department." });
      }
    } else if (targetUser.department.toString() !== toTeam.department_id.toString()) {
      return res.status(400).json({ success: false, message: "Cannot move a member to a team in a different department." });
    }

    if (targetUser.team.toString() === toTeamId.toString()) {
      return res.status(400).json({ success: false, message: "This user is already on that team." });
    }

    const fromTeamId = targetUser.team;
    const targetTeamAdmins = await User.find({ team: toTeamId, role: { $in: ["admin", "superadmin"] } });

    if (targetTeamAdmins.length === 0) {
      // No admin to ask — move immediately, log it as auto-approved for the audit trail.
      targetUser.team = toTeamId;
      await targetUser.save();

      await TeamTransferRequest.create({
        user: userId,
        fromTeam: fromTeamId,
        toTeam: toTeamId,
        department: targetUser.department,
        requestedBy: req.user.id,
        status: "auto_approved",
        respondedBy: req.user.id,
        respondedAt: new Date(),
      });

      return res.status(200).json({ success: true, autoApproved: true, message: `Moved instantly — ${toTeam.name} has no admin yet.` });
    }

    const request = await TeamTransferRequest.create({
      user: userId,
      fromTeam: fromTeamId,
      toTeam: toTeamId,
      department: targetUser.department,
      requestedBy: req.user.id,
      status: "pending",
    });

    await UserNotification.create(
      targetTeamAdmins.map((a) => ({
        user_id: a._id,
        type: "team_transfer_request",
        message: `A member has been proposed to join ${toTeam.name} — review the request in your Team Hub.`,
      }))
    );

    return res.status(200).json({ success: true, autoApproved: false, requestId: request._id, message: `Request sent to ${toTeam.name}'s admin for approval.` });
  } catch (err) {
    console.error("❌ Team Transfer Request Failure:", err.message);
    return res.status(500).json({ success: false, message: "Server Error: Failed to process transfer request." });
  }
});

// =========================================================================
// @route    GET /api/teams/transfer-requests
// @desc     Pending transfer requests awaiting the current admin's decision
//           (i.e. requests whose target team is this admin's own team).
// @access   Private (Admin/Superadmin)
// =========================================================================
router.get("/transfer-requests", [auth, admin], async (req, res) => {
  try {
    const isSuperAdmin = req.user.role === "superadmin";
    const query = { status: "pending" };

    if (isSuperAdmin && req.query.teamId) {
      query.toTeam = req.query.teamId;
    } else if (!isSuperAdmin) {
      if (!req.user.team) return res.status(200).json({ success: true, requests: [] });
      query.toTeam = req.user.team;
    }

    const requests = await TeamTransferRequest.find(query)
      .sort({ createdAt: -1 })
      .populate("user", "username avatarUrl xp")
      .populate("fromTeam", "name code")
      .populate("toTeam", "name code")
      .populate("requestedBy", "username")
      .lean();

    return res.status(200).json({ success: true, requests });
  } catch (err) {
    console.error("❌ Transfer Requests Fetch Failure:", err.message);
    return res.status(500).json({ success: false, message: "Server Error: Failed to load transfer requests." });
  }
});

// =========================================================================
// @route    PUT /api/teams/transfer-requests/:id/respond
// @desc     Approve or reject a pending transfer request — only the target
//           team's own admin (or a superadmin) may respond.
// @access   Private (Admin/Superadmin)
// =========================================================================
router.put("/transfer-requests/:id/respond", [auth, admin], async (req, res) => {
  const { approve } = req.body;
  if (typeof approve !== "boolean") {
    return res.status(400).json({ success: false, message: "Body must include `approve: true|false`." });
  }

  try {
    const request = await TeamTransferRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ success: false, message: "Transfer request not found." });
    if (request.status !== "pending") {
      return res.status(400).json({ success: false, message: `This request was already ${request.status}.` });
    }

    const isSuperAdmin = req.user.role === "superadmin";
    if (!isSuperAdmin && (!req.user.team || req.user.team.toString() !== request.toTeam.toString())) {
      return res.status(403).json({ success: false, message: "Forbidden: only the target team's admin can respond to this request." });
    }

    const toTeam = await Team.findById(request.toTeam);

    if (approve) {
      await User.findByIdAndUpdate(request.user, { team: request.toTeam });
      request.status = "approved";
    } else {
      request.status = "rejected";
    }
    request.respondedBy = req.user.id;
    request.respondedAt = new Date();
    await request.save();

    await UserNotification.create({
      user_id: request.requestedBy,
      type: "team_transfer_response",
      message: approve
        ? `Your request to move a member to ${toTeam?.name || "the team"} was approved.`
        : `Your request to move a member to ${toTeam?.name || "the team"} was rejected.`,
    });

    return res.status(200).json({ success: true, status: request.status });
  } catch (err) {
    console.error("❌ Transfer Request Response Failure:", err.message);
    return res.status(500).json({ success: false, message: "Server Error: Failed to respond to transfer request." });
  }
});

// =========================================================================
// @route    GET /api/teams/:departmentId
// @desc     Fetch all teams belonging to a specific department
// @access   Private (Authenticated Users/Admins)
// 🎯 Deliberately declared LAST — this catch-all single-segment param route
// would otherwise shadow every literal-path route above it (e.g. a request
// to /api/teams/transfer-requests would match here first, with Express
// trying — and failing — to parse "transfer-requests" as a departmentId).
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

module.exports = router;