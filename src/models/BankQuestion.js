// src/models/BankQuestion.js
//
// The assessment question bank. Questions belong to a MODULE (not a Path):
// a module is reused across many Paths, so its questions are written once and
// every Path containing the module can draw its Pre/Post tests from them.
// These are separate from the practice quiz cards inside a module.
//
//  • difficulty   — lets the engine build a Pre and a Post that are equally hard
//  • status       — draft (e.g. AI-drafted, awaiting review) | active (usable)
//                   | retired (kept for history; never drawn into a new test)
//  • stats        — answered / correct counts, updated as learners take tests
// The correct answer and explanation are select:false: they leave the server
// only to admins (bank editing) and to a learner after their Post-check.
const mongoose = require("mongoose");

const BankQuestionSchema = new mongoose.Schema(
  {
    moduleId: { type: mongoose.Schema.Types.ObjectId, ref: "Module", required: true },
    question: { type: String, required: [true, "Question text is required"], trim: true, maxlength: 2000 },
    options: {
      type: [{ type: String, trim: true, maxlength: 500 }],
      validate: {
        validator: (arr) => Array.isArray(arr) && arr.length >= 2 && arr.length <= 8 && arr.every((o) => o && o.trim()),
        message: "A question needs 2–8 non-empty options.",
      },
    },
    correctIndex: { type: Number, required: [true, "Pick the correct option"], select: false, min: 0 },
    explanation: { type: String, default: "", maxlength: 2000, select: false },
    difficulty: { type: String, enum: ["easy", "medium", "hard"], default: "medium" },
    status: { type: String, enum: ["draft", "active", "retired"], default: "active" },
    source: { type: String, enum: ["manual", "import", "ai"], default: "manual" },
    stats: {
      answered: { type: Number, default: 0 },
      correct: { type: Number, default: 0 },
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

BankQuestionSchema.pre("validate", function () {
  if (Array.isArray(this.options) && Number.isInteger(this.correctIndex) && this.correctIndex >= this.options.length) {
    this.invalidate("correctIndex", "The correct option must be one of the options.", this.correctIndex, "user defined");
  }
});

BankQuestionSchema.index({ moduleId: 1, status: 1, difficulty: 1 });

module.exports = mongoose.model("BankQuestion", BankQuestionSchema);
