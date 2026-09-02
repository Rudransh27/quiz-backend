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
    
    // 🏢 TARGET DEPARTMENTS ARRAY — a module can be published to one or more
    // departments at once. Empty ONLY when visibility is 'Global'; must hold
    // at least one entry for 'Departmental' or 'Team-Specific'.
    departments: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "Department" }],
      validate: {
        validator: function (arr) {
          return this.visibility === "Global" || (Array.isArray(arr) && arr.length > 0);
        },
        message: "At least one target department is required unless visibility is Global.",
      },
    },

    // 👥 TARGET TEAMS ARRAY
    // Array of team references (e.g., Sales, DevOps, Developer) — may span
    // any of the departments listed above. Used when visibility is
    // 'Team-Specific'. If visibility is 'Departmental', this remains empty
    // so every team in every target department has access.
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
    },

    // 🏷️ CATEGORY (a.k.a. "Tag") — the Learn page groups modules under a
    // single Category each; picked directly in the module create/edit form,
    // just like any other field here (no separate ownership/protection
    // scheme — see moduleRoutes.js). Every module always has one: if the
    // admin doesn't pick one, the create/update routes fall back to the
    // permanent "Uncategorized" bucket rather than leaving this null.
    categoryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      default: null,
    },

    // 🔒 SEQUENTIAL MODULE LOCK — this module's position within its own
    // category's unlock chain (see src/utils/moduleLock.js). Lower unlocks
    // first. Never left meaningless: moduleRoutes.js's resolveModuleOrder()
    // always assigns a real value on create (append-at-end of the resolved
    // category) and on any category reassignment; admins can also set it
    // explicitly via the drag-and-drop reorder endpoint. Ties (including
    // every pre-existing module, which defaults to 0) are broken
    // deterministically by _id in moduleLock.js's walk.
    order: {
      type: Number,
      default: 0,
    },

    // 🌍 REGIONS — independent of both the visibility/department/team RBAC
    // above and the single categoryId tag. A module can sit in several
    // regions at once (e.g. the same "Onboarding" module offered in both US
    // and Europe). Empty means unrestricted (visible in every region); a
    // non-empty array scopes it to only the listed regions. Managed
    // exclusively via regionRoutes.js's module-mapping endpoints. See
    // models/Region.js.
    regions: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Region",
      },
    ],
  },
  { timestamps: true }
);

// =========================================================================
// 🔍 PERFORMANCE ACCELERATION INDEXES
// =========================================================================
// Optimizes multi-tenant $or queries used to compile available modules on the user learn page
moduleSchema.index({ visibility: 1, departments: 1 });
// Powers "modules in category X" lookups AND the sorted-by-order lock walk.
moduleSchema.index({ categoryId: 1, order: 1 });
moduleSchema.index({ regions: 1 });

module.exports = mongoose.model("Module", moduleSchema);