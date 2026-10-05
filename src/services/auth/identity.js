// src/services/auth/identity.js
//
// Finds the ONE IRIS Orbit user behind an external (SSO) sign-in — never a
// second account for the same person.
//
// Microsoft (Entra ID), in order:
//   1. a linked identity: AuthIdentity (microsoft, tenant, oid)
//   2. a legacy link: User.microsoftId === oid (accounts linked before
//      AuthIdentity existed; the identity row is added on the way)
//   3. the verified corporate email — linked only when the token comes from
//      OUR tenant, the person is a member (not a guest from another
//      organisation), the domain is allowed, and the account isn't already
//      linked to a different Microsoft account (refused: identity_conflict)
//   4. otherwise a new account
// Linking to an unverified sign-up (someone registered the email but never
// proved they own the mailbox) discards that sign-up's password and codes:
// the Microsoft identity is the verified owner, and an attacker who
// pre-registered the email must not keep a way in.
const User = require("../../models/User");
const AuthIdentity = require("../../models/AuthIdentity");

const ALLOWED_EMAIL_DOMAINS = ["irisregtech.com", "irisbusiness.com"];
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class IdentityError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const allowedDomain = (email) => ALLOWED_EMAIL_DOMAINS.some((d) => email.endsWith(`@${d}`));

// A guest / external account signed in through our tenant: Entra adds `idp`
// (the home identity provider) for those, and `acct` = 1 when that optional
// claim is configured. Members of our own tenant carry neither.
function isExternalAccount(claims, tenantId) {
  if (claims.acct === 1 || claims.acct === "1") return true;
  if (claims.idp) {
    const idp = String(claims.idp);
    return !(tenantId && idp.includes(tenantId));
  }
  return false;
}

// The verified Microsoft identity from the ID token claims, or an
// IdentityError with a fixed code.
function microsoftIdentityFromClaims(claims, configuredTenantId) {
  const oid = typeof claims.oid === "string" ? claims.oid : "";
  const tid = typeof claims.tid === "string" ? claims.tid : "";
  const rawEmail = typeof claims.email === "string" && claims.email ? claims.email : claims.preferred_username;
  const email = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
  if (!oid || !email) throw new IdentityError("profile_missing");
  // The app is registered single-tenant; check the token agrees.
  if (GUID_RE.test(configuredTenantId || "") && tid.toLowerCase() !== configuredTenantId.toLowerCase()) {
    throw new IdentityError("wrong_tenant");
  }
  if (isExternalAccount(claims, tid || configuredTenantId)) throw new IdentityError("not_member");
  if (!allowedDomain(email)) throw new IdentityError("domain_denied");
  return { provider: "microsoft", subject: oid, tenantId: tid || configuredTenantId || "", email, displayName: typeof claims.name === "string" ? claims.name : "" };
}

async function uniqueUsername(displayName, email) {
  const base = (displayName || email.split("@")[0]).trim().replace(/[^a-zA-Z0-9_]/g, "").slice(0, 20) || "user";
  let candidate = base;
  for (let n = 1; await User.exists({ username: candidate }); n += 1) candidate = `${base}${n}`;
  return candidate;
}

async function ensureIdentity(userId, ident) {
  await AuthIdentity.updateOne(
    { provider: ident.provider, tenantId: ident.tenantId, subject: ident.subject },
    { $setOnInsert: { user_id: userId, emailAtLink: ident.email, linkedAt: new Date() }, $set: { lastUsedAt: new Date() } },
    { upsert: true },
  );
}

// → { user, created, linked }
async function resolveSsoUser(ident, { retry = true } = {}) {
  // 1. Linked identity
  const linkedIdentity = await AuthIdentity.findOne({ provider: ident.provider, tenantId: ident.tenantId, subject: ident.subject }).lean();
  if (linkedIdentity) {
    const user = await User.findById(linkedIdentity.user_id);
    if (user) {
      await AuthIdentity.updateOne({ _id: linkedIdentity._id }, { $set: { lastUsedAt: new Date() } });
      return { user, created: false, linked: false };
    }
    await AuthIdentity.deleteOne({ _id: linkedIdentity._id }); // its user was deleted
  }

  // 2. Legacy link on the user record (Microsoft only)
  if (ident.provider === "microsoft") {
    const legacy = await User.findOne({ microsoftId: ident.subject });
    if (legacy) {
      await ensureIdentity(legacy._id, ident);
      return { user: legacy, created: false, linked: false };
    }
  }

  // 3. Verified email → the existing account
  const byEmail = await User.findOne({ email: ident.email }).select("+password");
  if (byEmail) {
    const otherLink = await AuthIdentity.exists({ user_id: byEmail._id, provider: ident.provider, subject: { $ne: ident.subject } });
    if (otherLink || (ident.provider === "microsoft" && byEmail.microsoftId && byEmail.microsoftId !== ident.subject)) {
      throw new IdentityError("identity_conflict");
    }
    if (ident.provider === "microsoft") byEmail.microsoftId = ident.subject;
    if (!byEmail.isVerified) {
      byEmail.isVerified = true;
      byEmail.password = undefined;
      byEmail.emailVerificationToken = undefined;
      byEmail.emailVerificationExpire = undefined;
      byEmail.emailVerificationAttempts = 0;
      byEmail.resetPasswordToken = undefined;
      byEmail.resetPasswordExpire = undefined;
      // Keeps an unverified local sign-up's schema rule ("local accounts
      // need a password") satisfied once its password is gone.
      byEmail.authProvider = ident.provider;
    }
    await byEmail.save();
    await ensureIdentity(byEmail._id, ident);
    return { user: byEmail, created: false, linked: true };
  }

  // 4. New account
  try {
    const user = await User.create({
      username: await uniqueUsername(ident.displayName, ident.email),
      email: ident.email,
      authProvider: ident.provider,
      microsoftId: ident.provider === "microsoft" ? ident.subject : undefined,
      isVerified: true,
      role: "user",
    });
    await ensureIdentity(user._id, ident);
    return { user, created: true, linked: false };
  } catch (err) {
    // Two first-ever sign-ins racing: the other one created the account.
    if (retry && err && err.code === 11000) return resolveSsoUser(ident, { retry: false });
    throw err;
  }
}

// Which ways in this user has (for the profile and admin views).
async function signInMethods(user) {
  const ids = await AuthIdentity.find({ user_id: user._id }, "provider").lean();
  const providers = new Set(ids.map((i) => i.provider));
  if (user.microsoftId) providers.add("microsoft");
  const hasPassword = user.password !== undefined
    ? !!user.password
    : !!(await User.exists({ _id: user._id, password: { $exists: true, $nin: [null, ""] } }));
  if (hasPassword) providers.add("local");
  return [...providers];
}

module.exports = {
  microsoftIdentityFromClaims,
  resolveSsoUser,
  signInMethods,
  isExternalAccount,
  IdentityError,
  ALLOWED_EMAIL_DOMAINS,
};
