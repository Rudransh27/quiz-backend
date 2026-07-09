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
  },
  { timestamps: true },
);

// =========================================================================
// 🔍 OPTIMIZED MULTI-TENANT INDEX SET
// =========================================================================

// 🎯 INDEX 1: Pure Idempotency Guard (One unique progress tracking record per user per card)
UserCardProgressSchema.index({ user_id: 1, card_id: 1 }, { unique: true });

// ⚡ INDEX 2: Module Progress Engine Accelerator
// Instantly computes the progress percentage for a module dashboard view
UserCardProgressSchema.index({ user_id: 1, module_id: 1 });

// ⚡ INDEX 3: Topic Analytics Performance Accelerator
// Used when the module 'hasTopics: true' to break down progress by topics
UserCardProgressSchema.index({ user_id: 1, topic_id: 1 }, { sparse: true });

module.exports = mongoose.model("UserCardProgress", UserCardProgressSchema);
