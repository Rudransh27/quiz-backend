// src/models/AssessmentAttempt.js
//
// A learner's Pre or Post submission for a Path. One per (user, path, kind):
// the unique index makes a double-submit impossible. Graded on the server.
// Pre never awards XP and is never shown as a grade — it only records the
// learner's starting point; Post is the learner's score.
const mongoose = require("mongoose");

const AnswerSchema = new mongoose.Schema({
  questionId: { type: mongoose.Schema.Types.ObjectId, ref: "BankQuestion" },
  moduleId: { type: mongoose.Schema.Types.ObjectId, ref: "Module", default: null },
  selectedOption: { type: Number, default: null },
  isCorrect: { type: Boolean, default: false },
}, { _id: false });

const AssessmentAttemptSchema = new mongoose.Schema(
  {
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    pathId: { type: mongoose.Schema.Types.ObjectId, ref: "Path", required: true },
    kind: { type: String, enum: ["pre", "post"], required: true },
    // The locked test version taken (Post always reuses the Pre's version).
    formId: { type: mongoose.Schema.Types.ObjectId, ref: "AssessmentForm", default: null },
    formVersion: { type: Number, default: null },
    answers: { type: [AnswerSchema], default: [] },
    score: { type: Number, default: 0 },
    maxScore: { type: Number, default: 0 },
    percent: { type: Number, default: 0 },
    xpAwarded: { type: Number, default: 0 },
  },
  { timestamps: true }
);

AssessmentAttemptSchema.index({ user_id: 1, pathId: 1, kind: 1 }, { unique: true });
AssessmentAttemptSchema.index({ pathId: 1, kind: 1 });

module.exports = mongoose.model("AssessmentAttempt", AssessmentAttemptSchema);
