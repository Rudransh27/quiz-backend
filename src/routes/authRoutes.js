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
const { CryptoProvider } = require("@azure/msal-node");
const { resolveClientToday, shiftDateKey } = require("../utils/localDate");
const { loginLimiter, otpLimiter, forgotPasswordLimiter } = require("../middleware/rateLimiters");
const verifyCaptcha = require("../middleware/verifyCaptcha");
const { handleError } = require("../utils/safeError");
const AuthSession = require("../models/AuthSession");
const { startSession, closeSession, endUserSessions } = require("../services/auth/sessions");
const { recordAuthEvent } = require("../services/auth/audit");
const identity = require("../services/auth/identity");

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
// 🔒 A self-chosen team must be a real, non-Council team of the user's own
// department. Council membership makes an admin department-wide
// (utils/teamAccess.js), so it is only ever assigned by an admin, never
// picked by the user. Anything else resolves to null (no team).
async function resolveOwnTeam(teamId, departmentId) {
  if (!teamId || !departmentId || !mongoose.Types.ObjectId.isValid(String(teamId))) return null;
  const team = await mongoose.model("Team").findById(teamId).select("department_id isCouncil").lean();
  if (!team || team.isCouncil || String(team.department_id) !== String(departmentId)) return null;
  return team._id;
}

// 🔒 Request values that reach a Mongo filter must be plain strings — a JSON
// object such as {"$ne": null} or {"$regex": "^a"} would otherwise act as a
// query operator (match any account / probe which emails exist).
const cleanEmail = (v) => (typeof v === "string" && v.length <= 254 ? v.trim().toLowerCase() : null);
const MAX_OTP_ATTEMPTS = 5;
const escapeHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

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

// Same finding: in production, credentials and tokens must only travel over
// HTTPS. TLS ends at the proxy in front, so req.secure relies on `trust
// proxy` + the X-Forwarded-Proto header it sends — if that header is
// missing, every sign-in here gets 426, so check it when deploying.
function requireHttpsTransport(req, res, next) {
  if (process.env.NODE_ENV !== "production" || req.secure) {
    return next();
  }
  return res.status(426).json({
    success: false,
    message: "HTTPS is required for authentication requests.",
  });
}
router.use(requireHttpsTransport);

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
  const claimed = await User.findOneAndUpdate(
    { _id: userId, lastLoginBonusDate: { $ne: today } },
    { $set: { lastLoginBonusDate: today } },
    { new: true }
  );
  if (!claimed) return { awarded: false };
  // 🔒 XP LEDGER: the +1 goes through the idempotent ledger (one key per
  // user per day), like every other XP change.
  const { awardXp } = require("../services/xpLedger");
  await awardXp({ userId, amount: 1, source: "daily_login", idempotencyKey: `login:${userId}:${today}` });
  const fresh = await User.findById(userId, "xp").lean();
  return { awarded: true, xp: fresh?.xp ?? claimed.xp + 1 };
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
// Scoped to the API (and the Socket.IO handshake under /api/socket.io) so the
// cookie is never sent to other apps served from the same host.
const BINDING_COOKIE_PATH = "/api";

function issueBindingCookie(req, res) {
  const bindingNonce = crypto.randomBytes(32).toString("hex");
  const bindingHash = crypto.createHash("sha256").update(bindingNonce).digest("hex");
  res.cookie("orbit_bind", bindingNonce, {
    httpOnly: true,
    secure: req.secure,
    sameSite: req.secure ? "none" : "lax",
    maxAge: 24 * 60 * 60 * 1000, // mirrors the JWT's own 1d expiresIn
    path: BINDING_COOKIE_PATH,
  });
  return bindingHash;
}

// The JWT body every sign-in returns (login, verify-email, SSO, password
// change) — one shape, so the rest of the app can't tell them apart.
function sessionPayload(user, sessionId, bh, xp) {
  return {
    user: {
      id: user._id.toString(),
      role: user.role,
      department: user.department ? user.department.toString() : null,
      team: user.team ? user.team.toString() : null,
      regions: (user.regions || []).map((r) => r.toString()),
      username: user.username,
      avatarUrl: user.avatarUrl,
      avatarId: user.avatarId || "dev",
      xp: xp ?? (user.xp || 0),
      email: user.email,
      sessionId,
      bh,
    },
  };
}

// Starts an IRIS Orbit session for a person whose identity has been verified
// (services/auth/sessions records the sign-in, its method and "last login")
// and signs its JWT. A fresh sessionId and binding cookie every time, so a
// session can never be fixed in advance.
async function issueSessionToken(req, res, user, { provider, xp, isLogin = true }) {
  const { sessionId } = await startSession({ req, user, provider, isLogin });
  const payload = sessionPayload(user, sessionId, issueBindingCookie(req, res), xp);
  const token = await new Promise((resolve, reject) => {
    jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "1d" }, (err, t) => (err ? reject(err) : resolve(t)));
  });
  return { token, payload, sessionId };
}

// Compared against when an account has no password to check (unknown email,
// Microsoft-only account), so those answers take as long as a real check
// and timing doesn't reveal which emails have accounts.
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString("hex"), 10);

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
    const normalizedEmail = cleanEmail(email);
    if (!normalizedEmail || typeof username !== "string" || !username.trim() || typeof password !== "string") {
      return res.status(400).json({ success: false, message: "Please fill in your name, work email and password." });
    }

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
    const targetDepartmentCode = typeof department === "string" ? department.trim().toLowerCase() : "";
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
    const finalTeamId = await resolveOwnTeam(teamId, finalDepartmentId);

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
      <p>Hi ${escapeHtml(username.trim())},</p>
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
  const email = cleanEmail(req.body.email);
  const { otp } = req.body;
  const invalid = () => res.status(400).json({ success: false, message: "Invalid or expired OTP code." });
  try {
    if (!email || typeof otp !== "string" || !/^\d{6}$/.test(otp.trim())) return invalid();
    const hashedOTP = crypto.createHash("sha256").update(otp.trim()).digest("hex");
    // Look the account up by email alone, then compare the code — so wrong
    // guesses can be counted against THIS account and the code burned after
    // MAX_OTP_ATTEMPTS, whatever IPs the guesses come from.
    const user = await User.findOne({ email, isVerified: false, emailVerificationExpire: { $gt: Date.now() } })
      .select("+emailVerificationToken +emailVerificationAttempts");
    if (!user || !user.emailVerificationToken) return invalid();
    if (user.emailVerificationToken !== hashedOTP) {
      const attempts = (user.emailVerificationAttempts || 0) + 1;
      if (attempts >= MAX_OTP_ATTEMPTS) {
        await User.updateOne({ _id: user._id }, { $unset: { emailVerificationToken: 1, emailVerificationExpire: 1 }, $set: { emailVerificationAttempts: 0 } });
        return res.status(400).json({ success: false, message: "Too many wrong codes. Please register again to get a new code." });
      }
      await User.updateOne({ _id: user._id }, { $set: { emailVerificationAttempts: attempts } });
      return invalid();
    }
    user.emailVerificationAttempts = 0;

    user.isVerified = true;
    user.emailVerificationToken = undefined;
    user.emailVerificationExpire = undefined;
    await user.save();

    await recordAuthEvent({ type: "ACCOUNT_CREATED", req, userId: user._id, email: user.email, provider: "local", success: true });
    const { token, payload } = await issueSessionToken(req, res, user, { provider: "local" });
    // `streak` rides on the response body only (not the signed payload), as
    // with /login and /validate — a new account's first session would
    // otherwise show a blank streak.
    return res.status(200).json({
      success: true,
      token,
      user: { ...payload.user, streak: user.currentStreak || 0 },
      message: "Email verified successfully! Welcome to IRIS Orbit.",
    });
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
// 🔒 SSO login-CSRF / code-injection guard: a random `state` and a PKCE
// verifier are bound to THIS browser in a short-lived HttpOnly cookie, and the
// callback only accepts a code that comes back with the same state (and that
// redeems with the same verifier). Without it, an attacker could finish their
// own Microsoft sign-in in a victim's browser and log the victim in as them.
const SSO_COOKIE = "orbit_sso";
const ssoCookieOptions = (req) => ({ httpOnly: true, secure: req.secure, sameSite: "lax", path: BINDING_COOKIE_PATH });

router.get("/microsoft", async (req, res) => {
  try {
    const state = crypto.randomBytes(24).toString("hex");
    const { verifier, challenge } = await new CryptoProvider().generatePkceCodes();
    res.cookie(SSO_COOKIE, `${state}.${verifier}`, { ...ssoCookieOptions(req), maxAge: 10 * 60 * 1000 });
    const authUrl = await msalClient.getAuthCodeUrl({
      scopes: MICROSOFT_SCOPES,
      redirectUri: getMicrosoftRedirectUri(),
      state,
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
    });
    res.redirect(authUrl);
  } catch (err) {
    console.error("❌ Microsoft SSO auth-url generation failed:", err.message);
    res.redirect(`${process.env.CLIENT_URL}/sso/callback?error=start_failed`);
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
  // Only fixed codes travel in the URL — never request data or free text.
  // SsoCallback.jsx maps each code to a user-facing message. Every failure
  // is recorded (LOGIN_FAILED, method SSO) with a fixed reason code.
  const SSO_ERROR_CODES = new Set(["cancelled", "profile_missing", "domain_denied", "not_member", "identity_conflict", "session_failed", "failed"]);
  const fail = async (code, reason = code, extra = {}) => {
    await recordAuthEvent({ type: "LOGIN_FAILED", req, provider: "microsoft", success: false, reason, ...extra });
    return res.redirect(`${process.env.CLIENT_URL}/sso/callback?error=${SSO_ERROR_CODES.has(code) ? code : "failed"}`);
  };

  try {
    // Microsoft sends ?error=...&error_description=... instead of ?code=...
    // when something is actually wrong (redirect URI mismatch, consent
    // required, etc.) — never echoed to the browser. Only the error code is
    // logged, reduced to safe characters: the query string is attacker-
    // controlled, so raw values could forge log lines.
    if (req.query.error) {
      console.error("❌ Microsoft SSO returned an error:", String(req.query.error).replace(/[^\w.-]/g, "").slice(0, 64));
      return fail("cancelled", "provider_error");
    }

    if (!req.query.code || typeof req.query.code !== "string") {
      return fail("cancelled");
    }

    // The state must match the one this browser was given in /microsoft.
    const [expectedState, codeVerifier] = String((req.cookies && req.cookies[SSO_COOKIE]) || "").split(".");
    res.clearCookie(SSO_COOKIE, ssoCookieOptions(req));
    const gotState = typeof req.query.state === "string" ? req.query.state : "";
    if (!expectedState || !codeVerifier || gotState.length !== expectedState.length
        || !crypto.timingSafeEqual(Buffer.from(gotState), Buffer.from(expectedState))) {
      console.warn("🚨 Microsoft SSO callback with a missing/mismatched state — rejected.");
      return fail("failed", "state_mismatch");
    }

    const tokenResponse = await msalClient.acquireTokenByCode({
      code: req.query.code,
      scopes: MICROSOFT_SCOPES,
      redirectUri: getMicrosoftRedirectUri(),
      codeVerifier,
    });

    // Microsoft's own tokens stay on the server — only the verified identity
    // (tenant, object id, email, name) is read from the ID token, and none
    // of it is logged.
    const claims = tokenResponse.idTokenClaims || tokenResponse.account?.idTokenClaims || {};
    let ident;
    try {
      ident = identity.microsoftIdentityFromClaims(claims, process.env.MICROSOFT_TENANT_ID);
    } catch (err) {
      if (!(err instanceof identity.IdentityError)) throw err;
      return fail(err.code === "wrong_tenant" ? "domain_denied" : err.code, err.code);
    }

    // One IRIS Orbit user per person: an existing link, the same verified
    // corporate email, or a new account — never a duplicate.
    let resolved;
    try {
      resolved = await identity.resolveSsoUser(ident);
    } catch (err) {
      if (!(err instanceof identity.IdentityError)) throw err;
      console.warn(`🚨 Microsoft SSO identity refused (${err.code}) for ${ident.email}.`);
      return fail(err.code, err.code, { email: ident.email });
    }
    const { user, created, linked } = resolved;
    if (created) await recordAuthEvent({ type: "ACCOUNT_CREATED", req, userId: user._id, email: user.email, provider: "microsoft", success: true });
    if (linked) await recordAuthEvent({ type: "ACCOUNT_LINKED", req, userId: user._id, email: user.email, provider: "microsoft", success: true });

    let token;
    try {
      ({ token } = await issueSessionToken(req, res, user, { provider: "microsoft" }));
    } catch (err) {
      console.error("❌ Microsoft SSO session start failed:", err.message);
      return fail("session_failed", "session_failed", { userId: user._id, email: user.email });
    }
    // In the #fragment, not the query: browsers never send the fragment to
    // a server, so the token stays out of nginx/proxy logs and Referer.
    return res.redirect(`${process.env.CLIENT_URL}/sso/callback#token=${token}`);
  } catch (err) {
    console.error("❌ Microsoft SSO callback error:", err.message);
    return fail("failed");
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
    // 🔒 One-time step: once a department is set it can only be changed by
    // an admin. Re-running this would let anyone move themselves into
    // another department (and an admin become that department's admin).
    if (user.department) {
      return res.status(409).json({ success: false, message: "Your department is already set. Ask an admin to change it." });
    }

    // Same dynamic department-code lookup /register uses — accepts either
    // a department "code" or a raw ObjectId string.
    const targetDepartmentCode = typeof department === "string" ? department.trim().toLowerCase() : "";
    if (!targetDepartmentCode) {
      return res.status(400).json({ success: false, message: "Please select your department." });
    }

    const foundDepartment = await mongoose.model("Department").findOne({ code: targetDepartmentCode })
      || (mongoose.Types.ObjectId.isValid(department) ? await mongoose.model("Department").findById(department) : null);
    if (foundDepartment) {
      user.department = foundDepartment._id;
    } else {
      return res.status(400).json({ success: false, message: `The selected department '${department}' does not exist.` });
    }

    user.team = await resolveOwnTeam(teamId, user.department);

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
  const email = cleanEmail(req.body.email);
  const { password } = req.body;
  const invalid = () => res.status(400).json({ success: false, message: "Invalid credentials" });
  const failed = (reason, user = null) => recordAuthEvent({ type: "LOGIN_FAILED", req, userId: user ? user._id : null, email, provider: "local", success: false, reason });
  try {
    if (!email || typeof password !== "string") {
      return invalid();
    }
    const user = await User.findOne({ email }).select("+password +failedLoginAttempts +lockUntil");
    if (!user) {
      await bcrypt.compare(password, DUMMY_HASH);
      await failed("unknown_account");
      return invalid();
    }

    // 🔒 Per-account lockout — checked before spending a bcrypt.compare CPU
    // cycle, and before the password is even looked at, so a locked account
    // can't be used to keep probing passwords during its own lockout window.
    if (user.lockUntil && user.lockUntil > Date.now()) {
      await failed("locked", user);
      const minutesLeft = Math.ceil((user.lockUntil - Date.now()) / 60000);
      return res.status(423).json({
        success: false,
        message: `Account temporarily locked due to repeated failed login attempts. Try again in ${minutesLeft} minute(s).`,
      });
    }

    // An account that signs in with Microsoft and has no IRIS Orbit
    // password: answered exactly like a wrong password (no hint that the
    // account exists). No password is ever created for it here — corporate
    // users sign in with Microsoft (see AUTH_SSO_PASSWORD_LOGIN).
    if (!user.password) {
      await bcrypt.compare(password, DUMMY_HASH);
      await failed("sso_only", user);
      return invalid();
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      const updated = await User.findByIdAndUpdate(
        user._id,
        { $inc: { failedLoginAttempts: 1 } },
        { new: true, select: "failedLoginAttempts" },
      );
      await failed("bad_password", user);

      if (updated.failedLoginAttempts >= MAX_FAILED_LOGIN_ATTEMPTS) {
        await User.updateOne(
          { _id: user._id },
          { $set: { lockUntil: new Date(Date.now() + LOCKOUT_DURATION_MS), failedLoginAttempts: 0 } },
        );
        console.warn(`🚨 ACCOUNT LOCKED: ${email} after ${MAX_FAILED_LOGIN_ATTEMPTS} consecutive failed login attempts.`);
      } else {
        await sleep(progressiveDelayFor(updated.failedLoginAttempts));
      }

      return invalid();
    }

    // Only now (correct password) is it safe to say the account is
    // unverified — before, this answer told anyone which emails exist.
    if (!user.isVerified) {
      await failed("unverified", user);
      return res.status(401).json({
        success: false,
        message: "Please verify your email! OTP is sent to your mail.",
      });
    }

    // Clean slate on a successful login — a stray earlier mistype shouldn't
    // count against a future lockout window once the real password lands.
    if (user.failedLoginAttempts > 0 || user.lockUntil) {
      await User.updateOne({ _id: user._id }, { $set: { failedLoginAttempts: 0, lockUntil: null } });
    }

    // 🎯 First app-open-of-the-day bonus — covers the "fresh credentials
    // login" path (session-resume via a still-valid token is covered by
    // /validate below instead).
    const today = resolveClientToday(req.body.localDate);
    const loginBonus = await claimDailyLoginBonus(user._id, today);
    const effectiveXp = loginBonus.awarded ? loginBonus.xp : (user.xp || 0);

    const { token, payload } = await issueSessionToken(req, res, user, { provider: "local", xp: effectiveXp });
    return res.json({
      success: true,
      token,
      user: { ...payload.user, streak: user.currentStreak || 0 },
      loginBonusAwarded: loginBonus.awarded,
    });
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
        // From the sign-in system (services/auth/sessions), never editable.
        lastLoginAt: freshUserDoc.lastLoginAt || null,
        lastLoginMethod: freshUserDoc.lastLoginMethod || null,
        lastLoginProvider: freshUserDoc.lastLoginProvider || null,
        signInMethods: await identity.signInMethods(freshUserDoc),
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
// @desc     Ends THIS IRIS Orbit session on the server (its AuthSession row
//           — the token is refused from now on, also by any other tab of
//           this browser) and clears the session-binding cookie. Other
//           devices stay signed in. The Microsoft (Entra ID) session is NOT
//           ended: "Sign in with Microsoft" afterwards may go straight
//           through without a password prompt. Body { reason: "idle" } =
//           the browser's inactivity timer (recorded as SESSION_EXPIRED).
// @access   Private
// =========================================================================
router.post("/logout", auth, async (req, res) => {
  const idle = req.body && req.body.reason === "idle";
  try {
    await closeSession({
      sessionId: req.user.sessionId,
      userId: req.user.id,
      reason: idle ? "expired" : "logout",
      eventReason: idle ? "idle" : null,
      req,
    });
  } catch (err) {
    console.error("⚠️ Logout could not close the session record, continuing anyway:", err.message);
  }

  const cookieOpts = { httpOnly: true, secure: req.secure, sameSite: req.secure ? "none" : "lax" };
  res.clearCookie("orbit_bind", { ...cookieOpts, path: BINDING_COOKIE_PATH });
  res.clearCookie("orbit_bind", { ...cookieOpts, path: "/" }); // cookies issued before the path was narrowed
  res.json({ success: true, message: "Logged out." });
});

// =========================================================================
// @route    PUT /api/auth/update-profile
// @desc     Updates metadata payload fields and structures
// @access   Private
// =========================================================================
router.put("/update-profile", auth, async (req, res) => {
  // Team is NOT changeable here — team moves go through the approved
  // transfer-request flow (teamRoutes.js).
  const { username, avatarId, avatarUrl, regions } = req.body;
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    if (username !== undefined) {
      const clean = typeof username === "string" ? username.trim() : "";
      if (clean.length < 2 || clean.length > 40 || /[<>]/.test(clean)) {
        return res.status(400).json({ success: false, message: "Your name must be 2–40 characters (no < or >)." });
      }
      user.username = clean;
    }
    if (avatarId) user.avatarId = avatarId;
    if (regions !== undefined) user.regions = await resolveRegionIds(regions);

    // 🔒 Only images hosted in OUR Cloudinary account — an arbitrary URL is
    // loaded by every admin who opens the team dashboard (a tracking pixel /
    // offensive content).
    const OWN_CLOUDINARY = `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/`;
    if (avatarUrl && (typeof avatarUrl !== "string" || !process.env.CLOUDINARY_CLOUD_NAME || !avatarUrl.startsWith(OWN_CLOUDINARY))) {
      return res.status(400).json({ success: false, message: "Please upload your picture through Orbit." });
    }
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
// @desc     Change the logged-in user's own IRIS Orbit password. Accounts
//           that sign in with Microsoft and have no app password can't
//           (and aren't given one here). Every other session ends; this
//           browser gets a fresh session and token.
// @access   Private
// =========================================================================
router.put("/change-password", auth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  try {
    if (typeof currentPassword !== "string" || typeof newPassword !== "string" || !currentPassword || !newPassword) {
      return res.status(400).json({ success: false, message: "Current and new password are both required." });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, message: "New password must be at least 6 characters." });
    }

    const user = await User.findById(req.user.id).select("+password");
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    if (!user.password) {
      return res.status(400).json({ success: false, message: "Your account signs in with Microsoft and has no IRIS Orbit password." });
    }

    const isMatch = await user.matchPassword(currentPassword);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: "Current password is incorrect." });
    }

    user.password = newPassword; // pre("save") hook rehashes this (and stamps passwordChangedAt)
    await user.save();

    // 🔒 Every other session (other browsers / a thief's copy) ends — its
    // token predates passwordChangedAt and its session row is closed. This
    // browser gets a fresh session so the person who changed it stays in.
    const current = await AuthSession.findOne({ sessionId: req.user.sessionId }, "provider").lean();
    const { token, sessionId } = await issueSessionToken(req, res, user, { provider: current?.provider || "local", isLogin: false });
    await endUserSessions(user._id, "password_changed", { exceptSessionId: sessionId, req });
    await recordAuthEvent({ type: "PASSWORD_CHANGED", req, userId: user._id, email: user.email, provider: "local", success: true, sessionId });

    res.json({ success: true, message: "Password updated successfully. Other devices have been signed out.", token });
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