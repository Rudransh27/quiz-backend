// src/models/AuthSession.js
//
// One row per IRIS Orbit application session (one per sign-in, per device).
// Its `sessionId` travels inside the JWT; middleware/auth.js accepts a token
// only while its session row is active. That is what lets a session be
// ended before its JWT expires — on logout, after a password change/reset,
// or by an admin — without depending on Redis.
//
// This is the APPLICATION session only. A Microsoft (Entra ID) session lives
// at Microsoft and is not ended by signing out of IRIS Orbit.
const mongoose = require("mongoose");

const END_REASONS = ["logout", "expired", "revoked", "password_changed", "password_reset", "replaced"];

const AuthSessionSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, unique: true },
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  provider: { type: String, default: null }, // services/auth/providers.js key
  method: { type: String, default: null },   // LOCAL | SSO
  ip: { type: String, default: null },
  userAgent: { type: String, default: null },
  expiresAt: { type: Date, required: true },  // = the JWT's own expiry
  lastSeenAt: { type: Date, default: Date.now },
  endedAt: { type: Date, default: null },
  endReason: { type: String, enum: [...END_REASONS, null], default: null },
  endedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  // Created on first use for a token issued before session rows existed.
  adopted: { type: Boolean, default: false },
}, { timestamps: { createdAt: true, updatedAt: false } });

AuthSessionSchema.index({ user_id: 1, endedAt: 1 });
// Rows are removed 30 days after the session's expiry; the audit log
// (AuthEvent) keeps the history for much longer.
AuthSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600, name: "purge" });

AuthSessionSchema.statics.END_REASONS = END_REASONS;

module.exports = mongoose.model("AuthSession", AuthSessionSchema);
