// src/models/AssessmentReset.js
//
// Audit trail for an admin resetting a learner's Pre-check or Post-check on a
// Path. Resetting deletes the AssessmentAttempt (its unique index allows one
// per user/path/kind), so the deleted attempt's numbers are kept here.
//
// A row stays `pending` until the learner takes that check again. A pending
// Pre reset also overrides the "no baseline" rule in services/paths.js:
// without it, a learner who has already started the Path's modules would
// have their Pre-check skipped instead of offered again.
const mongoose = require("mongoose");

const AssessmentResetSchema = new mongoose.Schema(
  {
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    pathId: { type: mongoose.Schema.Types.ObjectId, ref: "Path", required: true },
    kind: { type: String, enum: ["pre", "post"], required: true },
    resetBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    reason: { type: String, default: "", maxlength: 500 },
    previous: {
      score: Number,
      maxScore: Number,
      percent: Number,
      formVersion: Number,
      xpAwarded: Number,
      takenAt: Date,
    },
    status: { type: String, enum: ["pending", "retaken"], default: "pending" },
    retakenAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

AssessmentResetSchema.index({ user_id: 1, pathId: 1, kind: 1, status: 1 });

module.exports = mongoose.model("AssessmentReset", AssessmentResetSchema);
