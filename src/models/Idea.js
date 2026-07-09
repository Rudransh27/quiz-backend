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
    enum: ["product", "market", "process", "publish"],
    required: true,
  },
  status: {
    type: String,
    enum: ["Submitted", "In Review", "Building", "Rejected"],
    default: "Submitted",
  },
  curatorFeedback: {
    type: String,
    default: "", // Stores notes like "Thanks, this is a very good suggestion..."
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