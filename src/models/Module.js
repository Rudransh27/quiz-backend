// src/models/Module.js
const mongoose = require("mongoose");

const moduleSchema = new mongoose.Schema(
  {
    title: { 
      type: String, 
      required: [true, "Please provide a module title"],
      trim: true 
    },
    description: {
      type: String,
      trim: true
    },
    imageUrl: {
      type: String,
      default: ""
    },

    // ⏱️ Admin-set estimate, in minutes — feeds computePointsReward() alongside
    // this module's card count (see src/utils/pointsCalculator.js).
    estimatedTime: {
      type: Number,
      default: 0
    },

    // 🔀 HYBRID STRUCTURAL CONTROL
    // True: Module ➔ Topics ➔ Cards (For large structured modules)
    // False: Module ➔ Cards directly (For multi-card flat sets including interactive HTML cards)
    hasTopics: {
      type: Boolean,
      default: true,
      required: true
    },

    // 🔀 ENGINE STRATEGY SELECTOR
    // Reverted back to the two primary data layout pipelines.
    // HTML sandboxes will now be processed as inline cards inside these pipelines!
    engineStrategy: {
      type: String,
      enum: ["STANDARD", "EXPRESS_FLAT"],
      default: "STANDARD",
      required: true
    },

    // 🌐 MODULE TYPE — 'html_sandbox' modules are EXPRESS_FLAT modules with a single
    // auto-managed backing Card{card_type:'html_sandbox'}; the whole module IS the sandbox.
    moduleType: {
      type: String,
      enum: ["standard", "html_sandbox"],
      default: "standard",
      required: true
    },

    // 🔥 PLATFORM-WIDE HOT MODULE — singleton flag; only one module may hold this
    // at a time (enforced via the PATCH /:id/hot-module route, not this schema).
    isHotModule: {
      type: Boolean,
      default: false
    },

    // ⭐ CURATED "Popular Modules" dashboard row — capped at 4 (enforced via the
    // PATCH /:id/popular route, not this schema).
    isPopular: {
      type: Boolean,
      default: false
    },

    // 🎯 THE THREE-LAYER VISIBILITY CONTROL
    visibility: {
      type: String,
      enum: ["Global", "Departmental", "Team-Specific"],
      default: "Departmental",
      required: true
    },
    
    // Required false ONLY if visibility is 'Global'.
    // Must be mapped if visibility is 'Departmental' or 'Team-Specific'.
    department: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Department", 
      required: function () {
        return this.visibility !== "Global";
      },
    },
    
    // 👥 TARGET TEAMS ARRAY
    // Array of team references (e.g., Sales, DevOps, Developer).
    // Used when visibility is 'Team-Specific'.
    // If visibility is 'Departmental', this remains empty so the entire department has access.
    targetTeams: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Team"
      }
    ],

    // 👤 OWNERSHIP — who created this module. Gates whether a Department
    // Admin (never a Superadmin, who is unrestricted) may cross the Global
    // scope boundary: push a module they don't own out to Global, or pull a
    // Global module they don't own into their own department. Modules
    // created before this field existed have no recorded creator — treated
    // as NOT owned by any Department Admin (safe default), so only a
    // Superadmin can move those across the Global boundary.
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    }
  },
  { timestamps: true }
);

// =========================================================================
// 🔍 PERFORMANCE ACCELERATION INDEXES
// =========================================================================
// Optimizes multi-tenant $or queries used to compile available modules on the user learn page
moduleSchema.index({ visibility: 1, department: 1 });

module.exports = mongoose.model("Module", moduleSchema);