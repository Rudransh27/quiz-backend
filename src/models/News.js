// src/models/News.js
const mongoose = require("mongoose");

const NewsSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, "Please provide a news post title"],
      trim: true,
    },
    content: {
      type: String,
      required: [true, "Please provide news post content"],
    },
    contentType: {
      type: String,
      enum: ["text", "image", "video"],
      default: "text",
    },
    // Used when contentType is "image" or "video" — a direct file URL or an
    // external link (e.g. a YouTube URL for video). Left "" for "text".
    mediaUrl: {
      type: String,
      default: "",
    },
    isBreaking: {
      type: Boolean,
      default: false,
    },
    // Two-tier scope (unlike Module's three-tier Global/Departmental/Team-
    // Specific) — News doesn't need team-level targeting per spec.
    scope: {
      type: String,
      enum: ["Global", "Departmental"],
      required: true,
    },
    // Only required when scope is "Departmental" — a Global post has no
    // single owning department.
    department: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Department",
      required: function () {
        return this.scope === "Departmental";
      },
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true }
);

// Accelerates the dashboard/manage queries, which always filter on scope
// (+ department when Departmental) and sort by recency.
NewsSchema.index({ scope: 1, department: 1, createdAt: -1 });

module.exports = mongoose.model("News", NewsSchema);
