// src/models/Idea.js
const mongoose = require("mongoose");

const IdeaSchema = new mongoose.Schema({
  title: {
    type: String,
    required: [true, "Please provide a one-line summary of your idea."],
    trim: true,
  },
  details: {
    type: String,
    required: [true, "Please elaborate on what, why, and for whom this idea is built."],
  },
  userName: {
    type: String,
    required: [true, "User author identity name parameter is required."],
  },
  userEmail: {
    type: String,
    required: [true, "Email mapping layer is required."],
  },
  tag: {
    type: String,
    enum: ["product", "process", "technology", "culture"],
    required: true,
  },
  // Lowercase to match every real write path (the curate route and the
  // admin UI have only ever used these lowercase values — this enum
  // previously declared Title Case values that nothing wrote, and went
  // unenforced since the curate route updates via findByIdAndUpdate
  // without runValidators).
  status: {
    type: String,
    enum: ["submitted", "in review", "building", "shipped", "parked", "rejected"],
    default: "submitted",
  },
  curatorFeedback: {
    type: String,
    default: "", // Stores notes like "Thanks, this is a very good suggestion..."
  },
  // Guards the one-time +25 XP curation bonus so it can only ever be paid
  // out once per idea — without this, a status oscillation (e.g. rejected
  // then re-approved) or two concurrent curate requests could both re-award
  // it, since the old check only compared against the idea's PRIOR status.
  xpAwarded: {
    type: Boolean,
    default: false,
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  departmentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Department",
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  }
});

// Compound indexing optimized for loading user history timelines instantly
IdeaSchema.index({ userId: 1, createdAt: -1 });
// Compound indexing for the Product Council board reviews
IdeaSchema.index({ departmentId: 1, status: 1 });

module.exports = mongoose.model("Idea", IdeaSchema);