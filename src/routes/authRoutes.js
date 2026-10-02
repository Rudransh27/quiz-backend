const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const mongoose = require("mongoose");
const User = require("../models/User");
const sendEmail = require("../utils/sendEmail");
const auth = require("../middleware/auth");
const authController = require("../controllers/authController");
const { msalClient, MICROSOFT_SCOPES, getMicrosoftRedirectUri } = require("../utils/msalClient");
const { resolveClientToday, shiftDateKey } = require("../utils/localDate");
const { loginLimiter, otpLimiter, forgotPasswordLimiter } = require("../middleware/rateLimiters");
const verifyCaptcha = require("../middleware/verifyCaptcha");
const { handleError } = require("../utils/safeError");

// 🌍 Resolves whatever `regions` the client submitted (array of ids, or a
// single id) down to only the ids that actually correspond to a real Region
// doc — silently drops anything invalid/stale rather than erroring, since
// region selection is optional (an empty/absent result just means
// "unrestricted", never a validation failure). Shared by /register,
// /complete-profile and /update-profile so all three agree on the same
// tolerant behavior.
async function resolveRegionIds(requestedRegions) {
  if (!requestedRegions) return [];
  const list = Array.isArray(requestedRegions) ? requestedRegions : [requestedRegions];
  const validIds = list
    .map((v) => (v && v._id ? v._id : v))
    .filter((v) => v && mongoose.Types.ObjectId.isValid(v.toString()));
  if (validIds.length === 0) return [];
  const found = await mongoose.model("Region").find({ _id: { $in: validIds } }).select("_id").lean();
  return found.map((r) => r._id);
}

// 🔒 Account lockout thresholds — shared between the failure branch (which
// counts up to this) and the lockout check (which uses the same duration).
const MAX_FAILED_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Progressive delay — each additional failed attempt on an account makes
// the NEXT failure response slower (capped at 4s), so an Intruder-style
// automated sweep slows to a crawl well before the account actually locks,
// without adding any noticeable delay for someone who mistypes once.
function progressiveDelayFor(failedAttempts) {
  return Math.min(failedAttempts * 600, 4000);
}

const router = express.Router();

// VAPT finding 7.6 (CWE-319, Sensitive Information Exposure in Clear Text) —
// every response on this router either carries a JWT + user profile (login,
// verify-email, validate, SSO callback) or otherwise reflects account state,
// so none of it should ever be cached by a browser, a shared/corporate proxy,
// or a CDN. Applied router-wide instead of per-route so a future endpoint
// added here doesn't silently miss it.
router.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

// Shared with /register's own domain check — kept in one place so both
// paths (password + SSO) always agree on which corporate domains are valid.
const ALLOWED_EMAIL_DOMAINS = ["irisregtech.com", "irisbusiness.com"];

// 🎯 Daily login bonus (+1 XP for showing up today) — separate from the 3-
// action streak system entirely (no engagementHistory/currentStreak touch),
// gated by its own lastLoginBonusDate so it pays out exactly once per
// calendar day regardless of how many times /login or /validate fire that
// day. Compare-and-swap update (same race-safe pattern as ideaRoutes.js's
// one-time "+25 XP on building" award) so two near-simultaneous requests
// can't double-pay.
async function claimDailyLoginBonus(userId, today) {
  const updated = await User.findOneAndUpdate(
    { _id: userId, lastLoginBonusDate: { $ne: today } },
    { $set: { lastLoginBonusDate: today }, $inc: { xp: 1 } },
    { new: true }
  );
  return updated ? { awarded: true, xp: updated.xp } : { awarded: false };
}

// 🔐 SESSION-BINDING COOKIE — closes the "capture a valid Superadmin JWT in
// Burp and paste it into a different session's Authorization header" attack.
// A Bearer token by itself is just a string: whoever holds it authenticates
// as its owner, and jwt.verify has no way to tell "the real owner's browser
// sent this" from "someone copied this out of an intercepted request." So a
// second factor rides alongside the JWT that a header-swap can't carry over:
// a random secret in an HttpOnly cookie (never readable by JS, never part of
// the Authorization header). Only its SHA-256 hash goes into the JWT payload
// (`bh`); auth.js recomputes the hash from whatever cookie arrived with the
// request and rejects the token if it doesn't match — which it won't, for a
// token pasted into a browser/session that never received this cookie.
function issueBindingCookie(req, res) {
  const bindingSecret = crypto.randomBytes(32).toString("hex");
  const bindingHash = crypto.createHash("sha256").update(bindingSecret).digest("hex");
  res.cookie("orbit_bind", bindingSecret, {
    httpOnly: true,
    secure: req.secure,
    sameSite: req.secure ? "none" : "lax",
    maxAge: 24 * 60 * 60 * 1000, // mirrors the JWT's own 1d expiresIn
    path: "/",
  });
  return bindingHash;
}

// =========================================================================
// @route    POST /api/auth/register
// @desc     Register user with hierarchical department and team lookup
// @access   Public
// =========================================================================
router.post("/register", verifyCaptcha, async (req, res) => {
  const { username, email, password, department, teamId, regions } = req.body;
  try {
    console.log("📥 Registration request received for:", email);

    // 🛡️ Multi-domain Whitelist Check
    const normalizedEmail = email.trim().toLowerCase();

    const isDomainValid = ALLOWED_EMAIL_DOMAINS.some(domain =>
      normalizedEmail.endsWith(`@${domain}`)
    );

    if (!isDomainValid) {
      const domainListString = ALLOWED_EMAIL_DOMAINS.map(d => `'@${d}'`).join(" or ");
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
    // crypto.randomInt (CSPRNG) — Math.random is predictable and flagged by
    // security scanners for anything used as a verification secret.
    const otp = crypto.randomInt(100000, 1000000).toString();
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

    // 🌍 Region selection is optional — an empty result just leaves the new
    // account unrestricted (sees every region) until they pick one later.
    const finalRegionIds = await resolveRegionIds(regions);

    // Construct profile database allocation wrapper blocks
    user = new User({
      username: username.trim(),
      email: normalizedEmail,
      password: password,
      department: finalDepartmentId,
      team: finalTeamId,
      regions: finalRegionIds,
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
      console.error("⚠️ SMTP Transport Fault:", mailErr.message);
      // 🛡️ Security fix: the OTP used to be returned in this response whenever
      // SMTP failed — on a live server that let anyone register with someone
      // else's email and verify it without access to that mailbox. Now only a
      // developer machine that explicitly opts in (DEV_OTP_FALLBACK=true, and
      // NODE_ENV not "production") gets the code back.
      if (process.env.NODE_ENV !== "production" && process.env.DEV_OTP_FALLBACK === "true") {
        return res.status(200).json({
          success: true,
          message: `[DEV MODE] Account saved. Your OTP code is: ${otp}`
        });
      }
      return res.status(503).json({
        success: false,
        message: "We couldn't send the verification email right now. Please try again in a few minutes.",
      });
    }

    return res.status(200).json({ success: true, message: "Verification OTP sent to your email." });
    
  } catch (err) {
    console.error("❌ CRITICAL REGISTRATION CRASH LOG:", err.message);
    return handleError(res, err, 500);
  }
});

// =========================================================================
// @route    POST /api/auth/verify-email
// @desc     Verify registration OTP and mint security token parameters
// @access   Public
// =========================================================================
router.post("/verify-email", otpLimiter, async (req, res) => {
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
        regions: (user.regions || []).map((r) => r.toString()),
        username: user.username,
        avatarUrl: user.avatarUrl,
        avatarId: user.avatarId || "dev",
        xp: user.xp || 0,
        sessionId: dynamicSessionId,
        bh: issueBindingCookie(req, res),
      },
    };

    jwt.sign(
      payload,
      process.env.JWT_SECRET,
      { expiresIn: "1d" },
      (err, token) => {
        if (err) throw err;
        // 🎯 BUG FIX: this response was missing `streak` entirely (unlike
        // /login and /validate, which both correctly include it) — so the
        // very first session after verifying a new account always
        // normalized to a blank/0 streak on the frontend, regardless of
        // what the database actually had. Matches /login's exact pattern:
        // keep the signed JWT payload minimal, add streak to the response
        // body's user object only.
        res.status(200).json({
          success: true,
          token,
          user: { ...payload.user, streak: user.currentStreak || 0 },
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
// @route    GET /api/auth/microsoft
// @desc     Kick off the Microsoft Entra ID (Azure AD) SSO flow — redirects
//           the browser to Microsoft's own login page.
// @access   Public
// =========================================================================
router.get("/microsoft", async (req, res) => {
  try {
    const authUrl = await msalClient.getAuthCodeUrl({
      scopes: MICROSOFT_SCOPES,
      redirectUri: getMicrosoftRedirectUri(),
    });
    res.redirect(authUrl);
  } catch (err) {
    console.error("❌ Microsoft SSO auth-url generation failed:", err.message);
    res.redirect(`${process.env.CLIENT_URL}/sso/callback?error=${encodeURIComponent("Could not start Microsoft sign-in. Please try again.")}`);
  }
});

// =========================================================================
// @route    GET /api/auth/microsoft/callback
// @desc     Exchanges the auth code for tokens, finds/links/creates the
//           matching User, and issues our own JWT — identical payload shape
//           to POST /login, so the rest of the app can't tell the two apart.
// @access   Public (reached only via Microsoft's own redirect)
// =========================================================================
router.get("/microsoft/callback", async (req, res) => {
  const redirectWithError = (message) =>
    res.redirect(`${process.env.CLIENT_URL}/sso/callback?error=${encodeURIComponent(message)}`);

  try {
    // Microsoft sends ?error=...&error_description=... instead of ?code=...
    // when something is actually wrong (redirect URI mismatch, consent
    // required, etc.) — surface that real reason instead of a generic
    // "cancelled" message that hides what's actually happening.
    if (req.query.error) {
      console.error("❌ Microsoft SSO returned an error:", req.query.error, "-", req.query.error_description);
      return redirectWithError(req.query.error_description || req.query.error);
    }

    if (!req.query.code) {
      return redirectWithError("Microsoft sign-in was cancelled or did not return an authorization code.");
    }

    const tokenResponse = await msalClient.acquireTokenByCode({
      code: req.query.code,
      scopes: MICROSOFT_SCOPES,
      redirectUri: getMicrosoftRedirectUri(),
    });

    const claims = tokenResponse.idTokenClaims || tokenResponse.account?.idTokenClaims || {};
    const oid = claims.oid || tokenResponse.account?.homeAccountId;
    const email = (claims.email || claims.preferred_username || tokenResponse.account?.username || "").trim().toLowerCase();
    const displayName = claims.name || tokenResponse.account?.name || "";

    if (!oid || !email) {
      return redirectWithError("Microsoft did not return the expected account details.");
    }

    // 🛡️ Same corporate-domain guard as /register — defense-in-depth even
    // though the Entra ID tenant should already be scoped to the company.
    const isDomainValid = ALLOWED_EMAIL_DOMAINS.some(domain => email.endsWith(`@${domain}`));
    if (!isDomainValid) {
      const domainListString = ALLOWED_EMAIL_DOMAINS.map(d => `'@${d}'`).join(" or ");
      return redirectWithError(`Access Denied. Only corporate emails from ${domainListString} are allowed.`);
    }

    let user = await User.findOne({ $or: [{ microsoftId: oid }, { email }] });

    if (!user) {
      // 🚀 First-ever SSO login for this email — auto-create the account.
      // Microsoft has already verified their identity, so isVerified is
      // true immediately (no OTP step). department/team are intentionally
      // left unset — the frontend routes them to /complete-profile next.
      const baseUsername = (displayName || email.split("@")[0])
        .trim().replace(/[^a-zA-Z0-9_]/g, "").slice(0, 20) || "user";
      let candidateUsername = baseUsername;
      let suffix = 0;
      while (await User.findOne({ username: candidateUsername })) {
        suffix += 1;
        candidateUsername = `${baseUsername}${suffix}`;
      }

      user = new User({
        username: candidateUsername,
        email,
        authProvider: "microsoft",
        microsoftId: oid,
        isVerified: true,
        role: "user",
      });
      await user.save();
      console.log(`✨ Auto-created SSO account for: ${email}`);
    } else if (!user.microsoftId) {
      // Existing password-based account, first time using SSO — link it.
      // Their password keeps working too; this only adds a second way in.
      user.microsoftId = oid;
      await user.save();
      console.log(`🔗 Linked existing account to Microsoft SSO: ${email}`);
    }

    const stringUserId = user._id.toString();
    const dynamicSessionId = crypto.randomUUID();

    if (global.redisClient && global.redisClient.isOpen && global.redisClient.isReady) {
      try {
        await global.redisClient.set(`session:${stringUserId}`, dynamicSessionId, { EX: 86400 });
        if (global.activeUserSockets && global.activeUserSockets.has(stringUserId)) {
          global.activeUserSockets.get(stringUserId).forEach((socketId) => {
            global.io.to(socketId).emit("force_logout_event", { newSessionId: dynamicSessionId });
          });
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
        team: user.team ? user.team.toString() : null,
        regions: (user.regions || []).map((r) => r.toString()),
        username: user.username,
        avatarUrl: user.avatarUrl,
        xp: user.xp || 0,
        email: user.email,
        avatarId: user.avatarId || "dev",
        sessionId: dynamicSessionId,
        bh: issueBindingCookie(req, res),
      },
    };

    jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "1d" }, (err, token) => {
      if (err) {
        console.error("❌ Microsoft SSO JWT signing failed:", err.message);
        return redirectWithError("Sign-in succeeded but session creation failed. Please try again.");
      }
      res.redirect(`${process.env.CLIENT_URL}/sso/callback?token=${token}`);
    });
  } catch (err) {
    console.error("❌ Microsoft SSO callback error:", err.message);
    redirectWithError("Microsoft sign-in failed. Please try again or contact IT.");
  }
});

// =========================================================================
// @route    PUT /api/auth/complete-profile
// @desc     One-time onboarding step for freshly auto-created SSO accounts —
//           assigns the department/team every other feature (visibility
//           scoping, admin dashboards) assumes every user already has.
// @access   Private
// =========================================================================
router.put("/complete-profile", auth, async (req, res) => {
  const { department, teamId, regions } = req.body;
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    // Same dynamic department-code lookup /register uses — accepts either
    // a department "code" or a raw ObjectId string.
    const targetDepartmentCode = department ? department.trim().toLowerCase() : "";
    if (!targetDepartmentCode) {
      return res.status(400).json({ success: false, message: "Please select your department." });
    }

    const foundDepartment = await mongoose.model("Department").findOne({ code: targetDepartmentCode });
    if (foundDepartment) {
      user.department = foundDepartment._id;
    } else if (mongoose.Types.ObjectId.isValid(department)) {
      user.department = department;
    } else {
      return res.status(400).json({ success: false, message: `The selected department '${department}' does not exist.` });
    }

    if (teamId && mongoose.Types.ObjectId.isValid(teamId)) {
      user.team = teamId;
    }

    if (regions !== undefined) {
      user.regions = await resolveRegionIds(regions);
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
        regions: (user.regions || []).map((r) => r.toString()),
        role: user.role,
        xp: user.xp || 0,
        avatarUrl: user.avatarUrl,
        avatarId: user.avatarId || "dev",
      },
    });
  } catch (err) {
    console.error("❌ complete-profile error:", err.message);
    res.status(500).json({ success: false, message: "Failed to save your department/team." });
  }
});

// =========================================================================
// @route    POST /api/auth/login
// @desc     Authenticates user, creates concurrent log maps & returns token
// @access   Public
// =========================================================================
router.post("/login", loginLimiter, verifyCaptcha, async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await User.findOne({ email }).select("+password +failedLoginAttempts +lockUntil");
    if (!user) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid credentials" });
    }

    // 🔒 Per-account lockout — checked before spending a bcrypt.compare CPU
    // cycle, and before the password is even looked at, so a locked account
    // can't be used to keep probing passwords during its own lockout window.
    if (user.lockUntil && user.lockUntil > Date.now()) {
      const minutesLeft = Math.ceil((user.lockUntil - Date.now()) / 60000);
      return res.status(423).json({
        success: false,
        message: `Account temporarily locked due to repeated failed login attempts. Try again in ${minutesLeft} minute(s).`,
      });
    }

    if (!user.isVerified) {
      return res.status(401).json({
        success: false,
        message: "Please verify your email! OTP is sent to your mail.",
      });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      const updated = await User.findByIdAndUpdate(
        user._id,
        { $inc: { failedLoginAttempts: 1 } },
        { new: true, select: "failedLoginAttempts" },
      );

      if (updated.failedLoginAttempts >= MAX_FAILED_LOGIN_ATTEMPTS) {
        await User.updateOne(
          { _id: user._id },
          { $set: { lockUntil: new Date(Date.now() + LOCKOUT_DURATION_MS), failedLoginAttempts: 0 } },
        );
        console.warn(`🚨 ACCOUNT LOCKED: ${email} after ${MAX_FAILED_LOGIN_ATTEMPTS} consecutive failed login attempts.`);
      } else {
        await sleep(progressiveDelayFor(updated.failedLoginAttempts));
      }

      return res
        .status(400)
        .json({ success: false, message: "Invalid credentials" });
    }

    // Clean slate on a successful login — a stray earlier mistype shouldn't
    // count against a future lockout window once the real password lands.
    if (user.failedLoginAttempts > 0 || user.lockUntil) {
      await User.updateOne({ _id: user._id }, { $set: { failedLoginAttempts: 0, lockUntil: null } });
    }

    const stringUserId = user._id.toString();
    const dynamicSessionId = crypto.randomUUID();

    // 🎯 First app-open-of-the-day bonus — covers the "fresh credentials
    // login" path (session-resume via a still-valid token is covered by
    // /validate below instead).
    const today = resolveClientToday(req.body.localDate);
    const loginBonus = await claimDailyLoginBonus(user._id, today);
    const effectiveXp = loginBonus.awarded ? loginBonus.xp : (user.xp || 0);

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
        regions: (user.regions || []).map((r) => r.toString()),
        username: user.username,
        avatarUrl: user.avatarUrl,
        xp: effectiveXp,
        email: user.email,
        avatarId: user.avatarId || "dev",
        sessionId: dynamicSessionId,
        bh: issueBindingCookie(req, res),
      },
    };

    jwt.sign(
      payload,
      process.env.JWT_SECRET,
      { expiresIn: "1d" },
      (err, token) => {
        if (err) throw err;
        res.json({
          success: true,
          token,
          user: { ...payload.user, streak: user.currentStreak || 0 },
          loginBonusAwarded: loginBonus.awarded,
        });
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
    // (client's own local calendar day when sent — see utils/localDate.js)
    const today     = resolveClientToday(req.body.localDate);
    const yesterday = shiftDateKey(today, -1);
    if (freshUserDoc.lastActiveDate && freshUserDoc.lastActiveDate !== today && freshUserDoc.lastActiveDate !== yesterday && freshUserDoc.currentStreak > 0) {
      freshUserDoc.currentStreak = 0;
      await freshUserDoc.save();
    }

    // 🎯 First app-open-of-the-day bonus — /validate fires once on every app
    // boot (AuthContext.initAuth), so a resumed session (the common case,
    // since most users stay logged in via token rather than re-entering
    // credentials daily) claims it here.
    const loginBonus = await claimDailyLoginBonus(freshUserDoc._id, today);
    const effectiveXp = loginBonus.awarded ? loginBonus.xp : (freshUserDoc.xp || 0);

    // Always deliver the most accurate, live database fields back to the client context
    return res.status(200).json({
      valid: true,
      user: {
        id: freshUserDoc._id.toString(),
        role: freshUserDoc.role || "user",
        department: freshUserDoc.department ? freshUserDoc.department.toString() : null,
        team: freshUserDoc.team ? freshUserDoc.team.toString() : null,
        regions: (freshUserDoc.regions || []).map((r) => r.toString()),
        username: freshUserDoc.username || "Corporate Specialist",
        email: freshUserDoc.email || "",
        xp: effectiveXp,
        streak: freshUserDoc.currentStreak || 0,
        avatarUrl: freshUserDoc.avatarUrl || "",
        avatarId: freshUserDoc.avatarId || "dev",
      },
      loginBonusAwarded: loginBonus.awarded,
    });

  } catch (error) {
    console.error("❌ High-scale validation microservice failed critical execution:", error.message);
    return res.status(500).json({ valid: false, message: "Internal Server Infrastructure Telemetry Error" });
  }
});

// =========================================================================
// @route    POST /api/auth/logout
// @desc     Ends the session server-side instead of just discarding the
//           token client-side — clears the session-binding cookie (so a
//           copy of the now-abandoned JWT can never satisfy the binding
//           check in auth.js again) and the Redis session record (so the
//           single-login-enforcement check also treats this session as over).
// @access   Private
// =========================================================================
router.post("/logout", auth, async (req, res) => {
  try {
    if (global.redisClient && global.redisClient.isOpen && global.redisClient.isReady) {
      await global.redisClient.del(`session:${req.user.id.toString()}`);
    }
  } catch (redisError) {
    console.error("⚠️ Redis Operational Fault during logout, continuing anyway:", redisError.message);
  }

  res.clearCookie("orbit_bind", { httpOnly: true, secure: req.secure, sameSite: req.secure ? "none" : "lax", path: "/" });
  res.json({ success: true, message: "Logged out." });
});

// =========================================================================
// @route    PUT /api/auth/update-profile
// @desc     Updates metadata payload fields and structures
// @access   Private
// =========================================================================
router.put("/update-profile", auth, async (req, res) => {
  const { username, avatarId, avatarUrl, teamId, regions } = req.body;
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    if (username) user.username = username;
    if (avatarId) user.avatarId = avatarId;
    if (teamId && mongoose.Types.ObjectId.isValid(teamId)) user.team = teamId;
    if (regions !== undefined) user.regions = await resolveRegionIds(regions);

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
        regions: (user.regions || []).map((r) => r.toString()),
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
// @route    PUT /api/auth/change-password
// @desc     Change the logged-in user's own password (local accounts only —
//           SSO accounts authenticate via Microsoft and have no local
//           password to change).
// @access   Private
// =========================================================================
router.put("/change-password", auth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  try {
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, message: "Current and new password are both required." });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, message: "New password must be at least 6 characters." });
    }

    const user = await User.findById(req.user.id).select("+password");
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    if (user.authProvider !== "local") {
      return res.status(400).json({ success: false, message: "SSO accounts sign in via Microsoft and don't use a local password." });
    }

    const isMatch = await user.matchPassword(currentPassword);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: "Current password is incorrect." });
    }

    user.password = newPassword; // pre("save") hook rehashes this
    await user.save();

    res.json({ success: true, message: "Password updated successfully." });
  } catch (err) {
    console.error("❌ Change password error:", err.message);
    res.status(500).json({ success: false, message: "Failed to change password." });
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
router.post("/forgot-password", forgotPasswordLimiter, verifyCaptcha, authController.forgotPassword);
router.put("/reset-password/:token", authController.resetPassword);

module.exports = router;