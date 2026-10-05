// src/models/AuthEvent.js
//
// Authentication audit log — sign-ins, sign-outs, session ends and password
// events. Deliberately separate from every learning collection (progress,
// grades, Pre/Post attempts): the two are queried and retained independently.
//
// Never stores secrets: no passwords, tokens, codes or identity-provider
// claims. `reason` is a short fixed code (e.g. "bad_password", "locked"),
// never free text from a request.
//
// An SSO login is a LOGIN_SUCCESS / LOGIN_FAILED with method "SSO" (and the
// provider, e.g. "microsoft") — one event type per outcome, so every login
// is counted once and a new provider needs no new event types.
const mongoose = require("mongoose");
const { METHODS } = require("../services/auth/providers");

const AUTH_EVENT_TYPES = [
  "LOGIN_SUCCESS",
  "LOGIN_FAILED",
  "LOGOUT",
  "SESSION_EXPIRED",
  "SESSION_REVOKED",
  "PASSWORD_RESET_REQUESTED",
  "PASSWORD_RESET",
  "PASSWORD_CHANGED",
  "ACCOUNT_CREATED",
  "ACCOUNT_LINKED",
];

const RETENTION_DAYS = Math.max(30, Number(process.env.AUTH_EVENT_RETENTION_DAYS) || 400);

const AuthEventSchema = new mongoose.Schema({
  type: { type: String, enum: AUTH_EVENT_TYPES, required: true },
  // null when the attempt didn't match an account (e.g. unknown email).
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  // The email that was used — only when it is a well-formed address.
  email: { type: String, default: null },
  method: { type: String, enum: [...METHODS, null], default: null },
  provider: { type: String, default: null },
  success: { type: Boolean, required: true },
  reason: { type: String, default: null },
  sessionId: { type: String, default: null },
  // Who did it, when it isn't the user themself (an admin ending sessions).
  actor_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  ip: { type: String, default: null },
  userAgent: { type: String, default: null },
}, { timestamps: { createdAt: true, updatedAt: false } });

AuthEventSchema.index({ user_id: 1, createdAt: -1 });
AuthEventSchema.index({ type: 1, createdAt: -1 });
AuthEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: RETENTION_DAYS * 24 * 3600, name: "retention" });

// Append-only: history is never rewritten (only expired by the TTL index).
const refuse = function () { throw new Error("AuthEvent records are immutable."); };
AuthEventSchema.pre(["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace"], refuse);
AuthEventSchema.pre("save", function () { if (!this.isNew) refuse(); });

AuthEventSchema.statics.TYPES = AUTH_EVENT_TYPES;

module.exports = mongoose.model("AuthEvent", AuthEventSchema);
