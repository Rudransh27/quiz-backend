// src/services/auth/providers.js
//
// The ways a person can sign in to IRIS Orbit. Whatever the way, they end up
// as the SAME User (one _id per person) — the provider only says HOW they
// authenticated this time:
//   • method   — the category recorded on every login and shown to admins
//                (LOCAL = the app's own email + password, SSO = an identity
//                provider such as Microsoft Entra ID)
//   • provider — the concrete one ("local", "microsoft", later "google", …)
// Adding a provider (Google, a SAML or OIDC IdP) = one entry here, a login
// route that verifies the person, resolves them with services/auth/identity
// and starts the session with services/auth/sessions.startSession.
const PROVIDERS = {
  local: { method: "LOCAL", protocol: "password", label: "Email & password" },
  microsoft: { method: "SSO", protocol: "oidc", label: "Microsoft" },
};

const METHODS = ["LOCAL", "SSO"];

const providerInfo = (provider) => PROVIDERS[provider] || null;
const methodOf = (provider) => providerInfo(provider)?.method || null;

// Policy switches (environment, so they can change without a deploy of code):
//  • AUTH_SSO_PASSWORD_LOGIN=true — let accounts created through SSO also set
//    an app password via "Forgot password". Off by default: corporate users
//    sign in with Microsoft, and no password is ever created for them.
//  • AUTH_SINGLE_SESSION=true — a new login ends the user's other sessions.
//    Off by default: users may stay signed in on several devices.
const flag = (name) => String(process.env[name] || "").toLowerCase() === "true";
const policy = {
  get ssoAccountsMayUsePassword() { return flag("AUTH_SSO_PASSWORD_LOGIN"); },
  get singleSession() { return flag("AUTH_SINGLE_SESSION"); },
};

module.exports = { PROVIDERS, METHODS, providerInfo, methodOf, policy };
