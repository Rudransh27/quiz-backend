const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: [true, "Please provide a username"],
    unique: true,
  },
  email: {
    type: String,
    required: [true, "Please provide an email"],
    unique: true,
    lowercase: true,
    validate: {
      validator: function (v) {
        const allowedDomains = ["irisregtech.com", "irisbusiness.com"];
        return allowedDomains.some((domain) =>
          v.toLowerCase().endsWith(`@${domain}`)
        );
      },
      message: (props) =>
        `Email domain is not allowed. Only corporate emails from '@irisregtech.com' or '@irisbusiness.com' are allowed.`,
    },
  },
  password: {
    type: String,
    // Only required for locally-registered accounts — SSO accounts
    // authenticate via Microsoft and never set a password here.
    required: function () { return this.authProvider === "local"; },
    minlength: 6,
    select: false,
  },
  role: {
    type: String,
    enum: ["user", "admin", "superadmin"],
    default: "user",
  },
  // 🔐 How this account was CREATED. "microsoft" accounts are auto-created
  // on first Entra ID SSO login (services/auth/identity.js) and skip both
  // the password field and the OTP verification flow, since Microsoft has
  // already verified their identity. Not how the person signs in today —
  // one account can have several ways in (AuthIdentity rows + an optional
  // password); each sign-in's method is recorded on lastLoginMethod and in
  // the AuthEvent audit log.
  authProvider: {
    type: String,
    enum: ["local", "microsoft"],
    default: "local",
  },
  // Azure AD's stable per-user object id (the `oid` claim) — used to find/
  // link this account on repeat SSO logins. Sparse so local-only accounts
  // (which never set this) don't collide on the unique index.
  microsoftId: {
    type: String,
    unique: true,
    sparse: true,
  },
  avatarUrl: {
    type: String,
    default: "https://res.cloudinary.com/your_cloud_name/image/upload/v1/default_avatar.png",
    required: false,
  },
  avatarId: {
    type: String,
    enum: ["dev", "xbrl", "db", "cyber", "custom"],
    default: "dev",
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  xp: {
    type: Number,
    default: 0,
    min: 0,
  },
  isVerified: {
    type: Boolean,
    default: false,
  },
  // Hashed one-time secrets — never returned by default queries.
  emailVerificationToken: { type: String, select: false },
  emailVerificationExpire: Date,
  // 🔒 Wrong OTP guesses against this account's current code; at 5 the
  // code is burned and a new one must be requested (per-ACCOUNT, on top of
  // the per-IP otpLimiter).
  emailVerificationAttempts: { type: Number, default: 0, select: false },
  resetPasswordToken: { type: String, select: false },
  resetPasswordExpire: Date,
  // 🔒 Set whenever the password changes; tokens issued before it are
  // rejected (middleware/auth.js), so a reset logs out every old session
  // even if Redis is unavailable.
  passwordChangedAt: { type: Date, default: null },
  // 🔒 Set when all of this user's sessions are ended (admin, password
  // reset): tokens issued before it that never got a session row are
  // refused too (services/auth/sessions.checkSession).
  sessionsRevokedAt: { type: Date, default: null },
  // Last successful sign-in — written only by services/auth/sessions, never
  // by profile or admin edits.
  lastLoginAt: { type: Date, default: null },
  lastLoginMethod: { type: String, default: null },   // LOCAL | SSO
  lastLoginProvider: { type: String, default: null }, // local | microsoft | …

  // 🔒 Brute-force lockout — separate from the loginLimiter IP rate limit
  // (middleware/rateLimiters.js): that one caps attempts per IP regardless
  // of target account, this caps attempts per ACCOUNT regardless of source
  // IP, so a distributed/credential-stuffing attack spread across many IPs
  // against one account still gets locked out.
  failedLoginAttempts: {
    type: Number,
    default: 0,
  },
  lockUntil: {
    type: Date,
    default: null,
  },
  
  // 🏢 LAYER 2: Department Placement (Carbon, iFile, iDeal, DataTech)
  department: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Department",
    // Required false for superadmins (who oversee the absolute macro cluster)
    // AND for freshly auto-created SSO accounts, which are saved before the
    // user has picked a department on the one-time /complete-profile screen
    // (see authRoutes.js's /microsoft/callback + PUT /complete-profile).
    required: function() { return this.role !== "superadmin" && this.authProvider !== "microsoft"; },
  },
  
  // 👥 LAYER 3: Specific Team Scoping (Finance, Sales, DevOps, Developer)
  team: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Team",
    required: false,
  },

  // 🌍 LAYER 4: Region Scoping (US, Europe, India, APAC, LATAM, ...) — a
  // separate dimension from department/team above, self-selected at
  // signup/profile (can hold several). Empty means unrestricted: sees
  // content in every region. A Superadmin always bypasses this filter
  // entirely regardless of what's set here. See models/Region.js and
  // utils/scopeHelpers.js's passesRegionScope/buildRegionMatch.
  regions: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Region",
    },
  ],

  // ── Streak & engagement tracking ────────────────────────────────────────────
  currentStreak: {
    type: Number,
    default: 0,
    min: 0,
  },
  longestStreak: {
    type: Number,
    default: 0,
    min: 0,
  },
  // Stored as "YYYY-MM-DD" for timezone-safe comparison without time drift
  lastActiveDate: {
    type: String,
    default: null,
  },
  // Separate from lastActiveDate (which tracks the 3 streak-qualifying
  // actions) — this gates the standalone "+1 for showing up today" login
  // bonus, awarded once per calendar day regardless of streak activity.
  lastLoginBonusDate: {
    type: String,
    default: null,
  },
  // Rolling engagement log — one entry per day the user was active
  engagementHistory: [{
    date:               { type: String, required: true },  // "YYYY-MM-DD"
    qualifiesForStreak: { type: Boolean, default: false }, // true when 1+ of 3 actions done
    actions: [{
      type: String,
      enum: ['daily_read', 'module_progress', 'idea_submission'],
    }],
  }],

  // 🏅 Achievement badges — once earned, permanently kept (e.g. a streak
  // badge stays even after the current streak later resets), unlike the
  // live counters above which reflect current state.
  badges: [{
    key:      { type: String, required: true },
    earnedAt: { type: Date, default: Date.now },
  }],
});

// =========================================================================
// 🌊 1. CASCADING DELETE TRIGGER MIDDLEWARE
// =========================================================================
userSchema.pre("findOneAndDelete", async function (next) {
  try {
    const query = this.getQuery();
    const userId = query._id;

    if (userId) {
      console.log(`Summary Clear Interceptor fired for User ID: ${userId}`);

      const UserCardProgress = mongoose.model("UserCardProgress");
      const UserTopicProgress = mongoose.model("UserTopicProgress");

      const cardDeleteResult = await UserCardProgress.deleteMany({ user_id: userId });
      const topicDeleteResult = await UserTopicProgress.deleteMany({ user_id: userId });

      console.log(`Orphan progress tracks purged! Cards Cleared: ${cardDeleteResult.deletedCount}, Topics Cleared: ${topicDeleteResult.deletedCount}`);
    }
    next();
  } catch (error) {
    console.error("Cascading Delete Failure Engine Blocked:", error.message);
    next(error); 
  }
});

// =========================================================================
// 🔐 2. PRE-SAVE SECURITY HOOK
// =========================================================================
userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  // Tokens issued before this moment stop working (middleware/auth.js).
  if (!this.isNew) this.passwordChangedAt = new Date();
  // Removed (an unverified sign-up claimed by SSO): nothing to hash.
  if (!this.password) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// =========================================================================
// 🧠 3. CUSTOM INSTANCE SCHEMAS METHODS
// =========================================================================
userSchema.methods.matchPassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

userSchema.methods.getResetPasswordToken = function () {
  const resetToken = crypto.randomBytes(20).toString("hex");
  this.resetPasswordToken = crypto.createHash("sha256").update(resetToken).digest("hex");
  this.resetPasswordExpire = Date.now() + 10 * 60 * 1000; 
  return resetToken;
};

userSchema.methods.getEmailVerificationToken = function () {
  const verificationToken = crypto.randomBytes(32).toString("hex");
  this.emailVerificationToken = crypto.createHash("sha256").update(verificationToken).digest("hex");
  this.emailVerificationExpire = Date.now() + 24 * 60 * 60 * 1000;
  return verificationToken;
};

module.exports = mongoose.model("User", userSchema);