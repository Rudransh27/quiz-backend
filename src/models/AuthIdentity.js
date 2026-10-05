// src/models/AuthIdentity.js
//
// An external sign-in identity (Microsoft today; Google, SAML, other OIDC
// providers later) linked to exactly one IRIS Orbit User. The identity
// provider's stable subject id — Microsoft's `oid` within its tenant — is
// what a repeat sign-in is matched on, never the email.
//
// The unique (provider, tenantId, subject) index means one external account
// can never belong to two users. A user may have several identities.
// User.microsoftId is kept in step for backward compatibility.
const mongoose = require("mongoose");

const AuthIdentitySchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  provider: { type: String, required: true },
  tenantId: { type: String, default: "" },
  subject: { type: String, required: true },
  emailAtLink: { type: String, default: null },
  linkedAt: { type: Date, default: Date.now },
  lastUsedAt: { type: Date, default: null },
});

AuthIdentitySchema.index({ provider: 1, tenantId: 1, subject: 1 }, { unique: true });
AuthIdentitySchema.index({ user_id: 1 });

module.exports = mongoose.model("AuthIdentity", AuthIdentitySchema);
