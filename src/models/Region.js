// src/models/Region.js
const mongoose = require("mongoose");

// 🌍 REGION — a top-level geographic dimension (US, Europe, India, APAC,
// LATAM, ...) sitting above Tags/Modules, independent of the existing
// Department/Team RBAC axis. A Category/Module with an EMPTY `regions`
// array is unrestricted (visible in every region), and a User with an
// empty `regions` array is unrestricted too (sees everything) — this keeps
// existing content/users working exactly as before until an admin
// deliberately opts something into a specific region.
//
// 🔒 THE PERMANENT "All" PSEUDO-REGION — mirrors Category's permanent
// "Uncategorized" bucket (see models/Category.js, utils/defaultCategory.js).
// Content teams think of "All regions" as a real, explicit value (see the
// spreadsheet that drove this), not as an absence of a value — so rather
// than leaving that implicit, `isDefault` marks one permanent Region named
// "All" that's always present, can't be renamed/deleted, and is excluded
// from the normal per-region assignment semantics: regionRoutes.js special-
// cases it so "assigning a tag/module to All" actually just CLEARS that
// doc's `regions` array back to empty (never stores the All region's own id
// anywhere) — keeping the empty-array-means-unrestricted invariant intact
// everywhere else (buildRegionMatch/passesRegionScope/the ?regionId= filter
// never need to know about this id at all). See utils/defaultRegion.js.
const regionSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Please provide a region name"],
      trim: true,
      unique: true,
    },
    code: {
      type: String,
      trim: true,
      uppercase: true,
      default: "",
    },
    description: {
      type: String,
      default: "",
    },
    // 🎨 Admin-picked accent color (hex) — drives the badge/chip color for
    // this region throughout the admin UI and any learner-facing surface.
    color: {
      type: String,
      default: "#6366f1",
    },
    order: {
      type: Number,
      default: 0,
    },
    isDefault: {
      type: Boolean,
      default: false,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true }
);

// "All" always sorts first regardless of its `order` value.
regionSchema.index({ isDefault: -1, order: 1, name: 1 });
// At most one region may ever be the permanent "All" bucket.
regionSchema.index(
  { isDefault: 1 },
  { unique: true, partialFilterExpression: { isDefault: true } }
);

module.exports = mongoose.model("Region", regionSchema);
