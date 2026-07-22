// src/models/DailyRead.js
const mongoose = require("mongoose");

const DailyReadSchema = new mongoose.Schema({
  title: {
    type: String,
    required: [true, "Please provide a daily read title"],
    trim: true,
  },
  content: {
    type: String,
    required: [true, "Please provide article content body"],
  },
  imageUrl: {
    type: String,
    default: "",
  },
  referenceLink: {
    type: String,
    default: "",
  },
  tags: [
    {
      type: String,
      trim: true,
    },
  ],
  postedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },

  // UTC "YYYY-MM-DD" for the calendar day this read belongs to (same
  // day-boundary convention as User.engagementHistory's streak entries).
  // Backs the "one per department per day" rule below.
  dateKey: {
    type: String,
    index: true,
  },

  // 🎯 STRICT SINGLE-LAYER VISIBILITY CONFIGURATION
  // Global option completely excised to isolate article streams to single business lines
  visibility: {
    type: String,
    enum: ["Departmental"],
    default: "Departmental",
    required: true
  },
  
  // 🏢 PERMANENTLY REQUIRED CONTEXT
  // Since visibility is strictly departmental now, this relationship marker is 100% mandatory
  department: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Department",
    required: [true, "A daily read article must be bound to a target parent department scope."],
  },
});

// =========================================================================
// 🔍 PERFORMANCE ACCELERATION INDEXES
// =========================================================================
// Refactored compound index: Excised visibility from indexing vectors since it is now static.
// This directly accelerates real-time sorting loops for department news feeds.
DailyReadSchema.index({ department: 1, createdAt: -1 });

// Enforces "one Daily Read per department per day" at the DB layer.
// sparse: true so legacy documents saved before dateKey existed (all
// missing the field) don't collide with each other under the unique index.
DailyReadSchema.index({ department: 1, dateKey: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model("DailyRead", DailyReadSchema);