// src/models/Path.js
//
// A Path is an ordered list of modules inside a Tag (Category) — what a
// learner actually walks through: Learn → Tag → Path → modules. It replaces
// the old Tag → Region → "journey" drill-down: instead of every learner
// picking a region, a Path carries its own AUDIENCE (regions / departments /
// teams) and the learner simply sees the Paths meant for them.
//
// Modules are referenced, not copied: the same module can sit in several
// Paths (e.g. a shared onboarding module), and progress is stored per
// module, so finishing it once counts in every Path that contains it.
//
// Rules (services/paths.js):
//  • A learner sees a Path when it is published, its audience matches them
//    (each non-empty audience list must match; empty = everyone), and at
//    least one of its modules is visible to them.
//  • Sequential unlock walks moduleIds in order (skipping modules the learner
//    can't see). With assessment.enabled, the first module waits for the Pre
//    check (unless the learner already had progress in the Path — "no
//    baseline"), and Post opens once every module is complete.
const mongoose = require("mongoose");

const PathSchema = new mongoose.Schema(
  {
    categoryId: { type: mongoose.Schema.Types.ObjectId, ref: "Category", required: true },
    name: { type: String, required: [true, "Please provide a path name"], trim: true, maxlength: 120 },
    description: { type: String, default: "", maxlength: 2000 },
    order: { type: Number, default: 0 },
    moduleIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Module" }],
    audience: {
      regions: [{ type: mongoose.Schema.Types.ObjectId, ref: "Region" }],
      departments: [{ type: mongoose.Schema.Types.ObjectId, ref: "Department" }],
      teams: [{ type: mongoose.Schema.Types.ObjectId, ref: "Team" }],
    },
    sequentialUnlock: { type: Boolean, default: true },
    status: { type: String, enum: ["draft", "published"], default: "draft" },
    assessment: {
      enabled: { type: Boolean, default: false },
      // How many bank questions per module go into EACH of Pre and Post.
      questionsPerModule: { type: Number, default: 2, min: 1, max: 5 },
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    // Set only on Paths created by scripts/migrate-tags-to-paths.js, so the
    // migration is idempotent and old Tag→Region links can be redirected.
    migrationKey: { type: String, default: undefined },
  },
  { timestamps: true }
);

PathSchema.index({ categoryId: 1, order: 1 });
PathSchema.index({ status: 1 });
PathSchema.index({ moduleIds: 1 });
PathSchema.index({ migrationKey: 1 }, { unique: true, partialFilterExpression: { migrationKey: { $type: "string" } } });

module.exports = mongoose.model("Path", PathSchema);
