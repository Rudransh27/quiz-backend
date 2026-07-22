const mongoose = require("mongoose");

const UserCardProgressSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    card_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Card",
      required: true,
    },
    // 🏢 ALWAYS REQUIRED: Denormalized for rapid module-level progress calculation (e.g., 45% completed)
    module_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Module",
      required: true,
    },
    // 🎯 CONDITIONALLY REQUIRED: Denormalized for fine-grained topic analytics.
    // Only required if the card belongs to a topic structural path.
    topic_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Topic",
      required: function () {
        // You can handle this constraint application-side or dynamically if needed,
        // but keeping it non-required at the DB level allows direct-to-module cards.
        return false;
      },
    },
    isCorrect: {
      type: Boolean,
      default: false,
    },
    timesAttempted: {
      type: Number,
      default: 1,
    },
    // A typical reference look inside your models/UserCardProgress.js
    score: { type: Number, default: 0 },
    maxScore: { type: Number, default: 0 },
    metaFeedbackLogs: { type: Object, default: {} },
    // 🎯 REVIEW MODE: the actual submitted answer, persisted so a revisit can
    // render a genuine read-only replay instead of a blank card. Only one of
    // these is ever populated, depending on card_type (quiz vs code).
    selectedOption: { type: Number, default: null },
    userCodeAnswer: { type: String, default: '' },
    // 🎯 RESET/REATTEMPT: the exact XP this specific doc ever contributed to
    // User.xp (kept in lockstep with every $inc: {xp: xpChange} applied
    // against this card, including admin grading deltas). A module reset
    // sums this field across scope docs and subtracts exactly that amount —
    // never a recomputed guess — so it can never drift or double-count.
    xpAwarded: { type: Number, default: 0 },
    // 🎯 RESET/REATTEMPT: archived (not deleted) on reset, so admin analytics/
    // grading history/CSV round-trips still see the historical record. All
    // "current state" queries (locking, review, completion %) must filter
    // isArchived out; historical admin/reporting queries deliberately don't.
    isArchived: { type: Boolean, default: false },
  },
  { timestamps: true },
);

// =========================================================================
// 🔍 OPTIMIZED MULTI-TENANT INDEX SET
// =========================================================================

// 🎯 INDEX 1: Pure Idempotency Guard (one ACTIVE progress tracking record per
// user per card). Scoped to non-archived docs only — $ne isn't allowed in a
// partial index filter, so this must be an exact-equality match — so a reset
// (which flips isArchived to true) frees the (user_id, card_id) pair for a
// brand-new doc on reattempt without violating uniqueness against the old,
// now-archived one.
UserCardProgressSchema.index(
  { user_id: 1, card_id: 1 },
  { unique: true, partialFilterExpression: { isArchived: false } },
);

// ⚡ INDEX 2: Module Progress Engine Accelerator
// Instantly computes the progress percentage for a module dashboard view
UserCardProgressSchema.index({ user_id: 1, module_id: 1 });

// ⚡ INDEX 3: Topic Analytics Performance Accelerator
// Used when the module 'hasTopics: true' to break down progress by topics
UserCardProgressSchema.index({ user_id: 1, topic_id: 1 }, { sparse: true });

module.exports = mongoose.model("UserCardProgress", UserCardProgressSchema);
