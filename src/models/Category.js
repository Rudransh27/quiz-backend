// src/models/Category.js
const mongoose = require("mongoose");

// 🏷️ CATEGORY (a.k.a. "Tag") — a flat, global grouping layer on top of
// Module for the learner-facing Learn page: Learn → pick a Category → see
// the modules assigned to it. A Module belongs to at most ONE Category
// (Module.categoryId) — there is no region axis, just a simple grouping.
// Every module always resolves to a real Category — one is reserved as the
// default bucket for modules nobody has explicitly tagged yet (see
// moduleRoutes.js's findOrCreateUncategorized helper). Modules within a
// category can also unlock sequentially, one at a time (see sequentialUnlock
// below and src/utils/moduleLock.js).
const categorySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Please provide a category name"],
      trim: true,
      unique: true,
    },
    description: {
      type: String,
      default: "",
    },
    order: {
      type: Number,
      default: 0,
    },
    // 🔒 The default "Uncategorized" bucket is seeded once and can never be
    // deleted (mirrors the earlier permanent-Region pattern) — every module
    // must always have SOME category, and this is the fallback.
    isDefault: {
      type: Boolean,
      default: false,
    },

    // 🔒 SEQUENTIAL MODULE LOCK — when true (default), the modules in this
    // category unlock one at a time in Module.order (first module open,
    // each next one unlocks once the previous is fully completed). When
    // false, every module in this category is unlocked for everyone
    // regardless of order/completion. Admin/superadmin viewers always see
    // every module unlocked either way (see src/utils/moduleLock.js).
    sequentialUnlock: {
      type: Boolean,
      default: true,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },

    // 🎯 THE SAME THREE-LAYER VISIBILITY CONTROL Module already has —
    // controls who can even SEE this tag (in the admin's own tag dropdown,
    // and on the learner Learn page), completely independent of which
    // modules happen to be assigned to it. Identical shape/rules to
    // Module.visibility/departments/targetTeams — see moduleRoutes.js's
    // POST/PUT scope-change RBAC, mirrored in categoryRoutes.js.
    visibility: {
      type: String,
      enum: ["Global", "Departmental", "Team-Specific"],
      default: "Global",
      required: true,
    },
    departments: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "Department" }],
      validate: {
        validator: function (arr) {
          return this.visibility === "Global" || (Array.isArray(arr) && arr.length > 0);
        },
        message: "At least one target department is required unless visibility is Global.",
      },
    },
    targetTeams: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Team",
      },
    ],

    // 🌍 REGIONS — independent of the visibility/department/team RBAC above.
    // Empty means unrestricted (visible in every region); a non-empty array
    // scopes this tag to only the listed regions. Managed exclusively via
    // regionRoutes.js's tag-mapping endpoints, not this resource's own
    // create/update routes. See models/Region.js.
    regions: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Region",
      },
    ],
  },
  { timestamps: true }
);

categorySchema.index({ order: 1, name: 1 });
categorySchema.index({ regions: 1 });
// At most one category may ever be the default bucket.
categorySchema.index(
  { isDefault: 1 },
  { unique: true, partialFilterExpression: { isDefault: true } }
);
// Optimizes the visibility $or filter used to compile categories visible to
// the requesting user — same shape as Module's identical index.
categorySchema.index({ visibility: 1, departments: 1 });

module.exports = mongoose.model("Category", categorySchema);
