// src/models/AssessmentForm.js
//
// The fixed Pre-check and Post-check of one Path, generated from the module
// question bank (services/formGenerator.js). Versioned:
//  • draft  — admin can regenerate or swap single questions
//  • locked — what learners take; never edited again. Changing a locked test
//             creates the next version as a new draft. A learner's Post-check
//             always uses the same version as their Pre-check, so the two
//             scores stay comparable.
const mongoose = require("mongoose");

const SlotSchema = new mongoose.Schema({
  questionId: { type: mongoose.Schema.Types.ObjectId, ref: "BankQuestion", required: true },
  moduleId: { type: mongoose.Schema.Types.ObjectId, ref: "Module", required: true },
}, { _id: false });

const AssessmentFormSchema = new mongoose.Schema(
  {
    pathId: { type: mongoose.Schema.Types.ObjectId, ref: "Path", required: true },
    version: { type: Number, required: true },
    status: { type: String, enum: ["draft", "locked"], default: "draft" },
    perModule: { type: Number, required: true },
    // The Path's modules when this version was generated (to flag a test that
    // no longer matches the Path after modules are added/removed).
    moduleIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Module" }],
    pre: { type: [SlotSchema], default: [] },
    post: { type: [SlotSchema], default: [] },
    lockedAt: { type: Date, default: null },
    lockedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

AssessmentFormSchema.index({ pathId: 1, version: 1 }, { unique: true });

module.exports = mongoose.model("AssessmentForm", AssessmentFormSchema);
