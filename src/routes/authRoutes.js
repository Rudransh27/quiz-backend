const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const mongoose = require("mongoose");
const User = require("../models/User");
const sendEmail = require("../utils/sendEmail");
const auth = require("../middleware/auth");
const authController = require("../controllers/authController");

const router = express.Router();

// =========================================================================
// @route    POST /api/auth/register
// @desc     Register user with hierarchical department and team lookup
// @access   Public
// =========================================================================
router.post("/register", async (req, res) => {
  const { username, email, password, department, teamId } = req.body;
  try {
    console.log("📥 Registration request received for:", email);

    // 🛡️ Multi-domain Whitelist Check
    const allowedDomains = ["irisregtech.com", "irisbusiness.com"]; 
    const normalizedEmail = email.trim().toLowerCase();
    
    const isDomainValid = allowedDomains.some(domain => 
      normalizedEmail.endsWith(`@${domain}`)
    );

    if (!isDomainValid) {
      const domainListString = allowedDomains.map(d => `'@${d}'`).join(" or ");
      return res.status(400).json({
        success: false,
        message: `Access Denied. Only corporate emails from ${domainListString} are allowed.`,
      });
    }
    
    // Check for existing records safely
    let user = await User.findOne({ email: normalizedEmail });
    if (user) {
      if (user.isVerified) {
        return res.status(400).json({
          success: false,
          message: "User already exists and is verified.",
        });
      }
      // Clear out older stale unverified registration rows to free up unique fields
      await User.deleteOne({ email: normalizedEmail });
      console.log(`🧹 Purged existing unverified duplicate record for: ${normalizedEmail}`);
    }

    // Secure OTP Generations Matrix
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const hashedOTP = crypto.createHash("sha256").update(otp).digest("hex");

    // ✨ DYNAMIC DEPARTMENT LOOKUP (No Hardcoded IDs!)
    const targetDepartmentCode = department ? department.trim().toLowerCase() : "";
    let finalDepartmentId = null;

    if (targetDepartmentCode) {
      const foundDepartment = await mongoose.model("Department").findOne({ code: targetDepartmentCode });
      
      if (foundDepartment) {
        finalDepartmentId = foundDepartment._id;
      } else if (mongoose.Types.ObjectId.isValid(department)) {
        // Fallback: Use direct hex ID string if frontend passed it instead of a code string
        finalDepartmentId = department;
      } else {
        return res.status(400).json({
          success: false,
          message: `Operational Fault: The designated business line segment '${department}' does not exist.`
        });
      }
    }

    // Check optional dynamic team allocation parameters safely
    const finalTeamId = mongoose.Types.ObjectId.isValid(teamId) ? teamId : null;

    // Construct profile database allocation wrapper blocks
    user = new User({
      username: username.trim(),
      email: normalizedEmail,
      password: password, 
      department: finalDepartmentId, 
      team: finalTeamId,
      role: "user",
      isVerified: false, 
      emailVerificationToken: hashedOTP,
      emailVerificationExpire: Date.now() + 10 * 60 * 1000, 
    });

    await user.save();
    console.log(`✨ DB Save Success for user: ${normalizedEmail}`);

    const message = `
      <h3>IRIS Orbit Platform - Verification Code</h3>
      <p>Hi ${username},</p>
      <p>Your 6-digit verification code is: <strong>${otp}</strong></p>
      <p>This code is valid for 10 minutes. If you didn't request this, please ignore.</p>
    `;

    try {
      await sendEmail({
        email: user.email,
        subject: "Verify Your Account - IRIS Orbit",
        html: message,
      });
      console.log(`📬 Verification email successfully sent to: ${user.email}`);
    } catch (mailErr) {
      console.error("⚠️ SMTP Transport Fault (Gracefully Bypassed):", mailErr.message);
      return res.status(200).json({ 
        success: true, 
        message: `[DEV MODE] Account saved. Your OTP code is: ${otp}` 
      });
    }

    return res.status(200).json({ success: true, message: "Verification OTP sent to your email." });
    
  } catch (err) {
    console.error("❌ CRITICAL REGISTRATION CRASH LOG:", err.message);
    return res.status(500).json({ success: false, message: `Server Error: ${err.message}` });
  }
});

// =========================================================================
// @route    POST /api/auth/verify-email
// @desc     Verify registration OTP and mint security token parameters
// @access   Public
// =========================================================================
router.post("/verify-email", async (req, res) => {
  const { email, otp } = req.body;
  try {
    const hashedOTP = crypto.createHash("sha256").update(otp).digest("hex");
    const user = await User.findOne({
      email,
      emailVerificationToken: hashedOTP,
      emailVerificationExpire: { $gt: Date.now() },
    });

    if (!user) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid or expired OTP code." });
    }

    user.isVerified = true;
    user.emailVerificationToken = undefined;
    user.emailVerificationExpire = undefined;
    await user.save();

    const stringUserId = user._id.toString();
    const dynamicSessionId = crypto.randomUUID();

    // Cache initialization loop synchronization check
    if (global.redisClient && global.redisClient.isOpen && global.redisClient.isReady) {
      await global.redisClient.set(
        `session:${stringUserId}`,
        dynamicSessionId,
        { EX: 86400 },
      );
    }

    const payload = {
      user: {
        id: stringUserId,
        role: user.role,
        department: user.department ? user.department.toString() : null,
        team: user.team ? user.team.toString() : null, // Embedded team matrix support cleanly
        username: user.username,
        avatarUrl: user.avatarUrl,
        avatarId: user.avatarId || "dev",
        xp: user.xp || 0,
        sessionId: dynamicSessionId,
      },
    };

    jwt.sign(
      payload,
      process.env.JWT_SECRET,
      { expiresIn: "1d" },
      (err, token) => {
        if (err) throw err;
        res.status(200).json({
          success: true,
          token,
          user: payload.user,
          message: "Email verified successfully! Welcome to IRIS Orbit.",
        });
      },
    );
  } catch (err) {
    console.error("❌ Email Verification Server Error:", err.message);
    res.status(500).json({ success: false, message: "Server Error" });
  }
});

// =========================================================================
// @route    POST /api/auth/login
// @desc     Authenticates user, creates concurrent log maps & returns token
// @access   Public
// =========================================================================
router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await User.findOne({ email }).select("+password");
    if (!user) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid credentials" });
    }

    if (!user.isVerified) {
      return res.status(401).json({
        success: false,
        message: "Please verify your email! OTP is sent to your mail.",
      });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid credentials" });
    }

    const stringUserId = user._id.toString();
    const dynamicSessionId = crypto.randomUUID();

    // Redis Concurrent Token Handshake Validation check blocks
    if (global.redisClient && global.redisClient.isOpen && global.redisClient.isReady) {
      try {
        await global.redisClient.set(
          `session:${stringUserId}`,
          dynamicSessionId,
          { EX: 86400 },
        );
        console.log(`🚀 Redis Log: New active session registered for User: ${stringUserId}`);

        if (global.activeUserSockets && global.activeUserSockets.has(stringUserId)) {
          const targetSocketIds = global.activeUserSockets.get(stringUserId);
          targetSocketIds.forEach((socketId) => {
            global.io.to(socketId).emit("force_logout_event", {
              newSessionId: dynamicSessionId,
            });
          });
          console.log(`⚡ WebSocket Signal Dispatched to terminate old context machine arrays for: ${stringUserId}`);
        }
      } catch (redisError) {
        console.error("⚠️ Redis Operational Fault, gracefully bypassing cache sync:", redisError.message);
      }
    }

    const payload = {
      user: {
        id: stringUserId,
        role: user.role,
        department: user.department ? user.department.toString() : null,
        team: user.team ? user.team.toString() : null, // Passed down cluster layer context
        username: user.username,
        avatarUrl: user.avatarUrl,
        xp: user.xp || 0,
        email: user.email,
        avatarId: user.avatarId || "dev",
        sessionId: dynamicSessionId,
      },
    };

    jwt.sign(
      payload,
      process.env.JWT_SECRET,
      { expiresIn: "1d" },
      (err, token) => {
        if (err) throw err;
        res.json({ success: true, token, user: { ...payload.user, streak: user.currentStreak || 0 } });
      },
    );
  } catch (err) {
    console.error("❌ Login Master Controller Crash Exception:", err.message);
    res.status(500).json({ success: false, message: "Server Error" });
  }
});

// =========================================================================
// @route    POST /api/auth/validate
// @desc     Validates active context payload & re-hydrates hydration profiles
// @access   Private
// =========================================================================
// backend/routes/auth.js (or your auth routes file)
router.post("/validate", auth, async (req, res) => {
  try {
    const contextUser = req.user.user ? req.user.user : req.user;
    
    if (!contextUser) {
      return res.status(401).json({
        valid: false,
        message: "Security Handshake Failed: Integrity context drop.",
      });
    }

    let userIdStr = contextUser.id ? contextUser.id.toString() : contextUser._id.toString();

    // =========================================================================
    // 🎯 FIXED: BYPASS STALE TOKEN MEMORY & PULL LIVE SNAPSHOT ON EVERY HIT
    // =========================================================================
    const freshUserDoc = await User.findById(userIdStr);
    
    if (!freshUserDoc) {
      return res.status(404).json({
        valid: false,
        message: "Security Handshake Failed: Profile record not found in cluster database.",
      });
    }

    // Auto-break streak if user missed a day before returning the live snapshot
    const today     = new Date().toISOString().split('T')[0];
    const yesterday = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return d.toISOString().split('T')[0]; })();
    if (freshUserDoc.lastActiveDate && freshUserDoc.lastActiveDate !== today && freshUserDoc.lastActiveDate !== yesterday && freshUserDoc.currentStreak > 0) {
      freshUserDoc.currentStreak = 0;
      await freshUserDoc.save();
    }

    // Always deliver the most accurate, live database fields back to the client context
    return res.status(200).json({
      valid: true,
      user: {
        id: freshUserDoc._id.toString(),
        role: freshUserDoc.role || "user",
        department: freshUserDoc.department ? freshUserDoc.department.toString() : null,
        team: freshUserDoc.team ? freshUserDoc.team.toString() : null,
        username: freshUserDoc.username || "Corporate Specialist",
        email: freshUserDoc.email || "",
        xp: freshUserDoc.xp || 0,
        streak: freshUserDoc.currentStreak || 0,
        avatarUrl: freshUserDoc.avatarUrl || "",
        avatarId: freshUserDoc.avatarId || "dev",
      },
    });

  } catch (error) {
    console.error("❌ High-scale validation microservice failed critical execution:", error.message);
    return res.status(500).json({ valid: false, message: "Internal Server Infrastructure Telemetry Error" });
  }
});

// =========================================================================
// @route    PUT /api/auth/update-profile
// @desc     Updates metadata payload fields and structures
// @access   Private
// =========================================================================
router.put("/update-profile", auth, async (req, res) => {
  const { username, avatarId, avatarUrl, teamId } = req.body;
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    if (username) user.username = username;
    if (avatarId) user.avatarId = avatarId;
    if (teamId && mongoose.Types.ObjectId.isValid(teamId)) user.team = teamId;

    if (avatarUrl) {
      user.avatarUrl = avatarUrl;
      if (avatarId === "custom") user.avatarId = "custom";
    }

    await user.save();

    res.json({
      success: true,
      user: {
        id: user._id.toString(),
        email: user.email,
        username: user.username,
        department: user.department ? user.department.toString() : null,
        team: user.team ? user.team.toString() : null,
        role: user.role,
        xp: user.xp || 0,
        avatarUrl: user.avatarUrl,
        avatarId: user.avatarId || "dev",
      },
    });
  } catch (err) {
    console.error("❌ Profile update error:", err.message);
    res.status(500).json({ success: false, message: "Failed to update profile." });
  }
});

// =========================================================================
// @route    DELETE /api/auth/profile
// @desc     Trigger cascading purge maps on user request logs
// @access   Private
// =========================================================================
router.delete("/profile", auth, async (req, res) => {
  try {
    const sessionUserId = req.user.id;
    console.log(`📡 Express interface received explicit delete payload trigger for User: ${sessionUserId}`);

    const purgedUser = await User.findByIdAndDelete(sessionUserId);
    if (!purgedUser) {
      return res.status(404).json({ success: false, message: "Target database entity missing." });
    }

    return res.status(200).json({
      success: true,
      message: "Your profile information and all linked progression analytics files were successfully purged.",
    });
  } catch (err) {
    console.error("❌ Delete Controller Exception Handshake Blocked:", err.message);
    return res.status(500).json({ success: false, message: "Server error processing cascade delete parameters." });
  }
});

// Controller pipeline assignments for structural security concerns
router.post("/forgot-password", authController.forgotPassword);
router.put("/reset-password/:token", authController.resetPassword);

module.exports = router;