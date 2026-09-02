// src/utils/defaultRegion.js
const Region = require("../models/Region");

// 🔒 The permanent "All" pseudo-region — mirrors getOrCreateUncategorizedCategory.
// Lazily created/promoted on first use (upsert by `name`, not `isDefault`,
// so it can never collide with the unique name index). Assigning a tag or
// module to this region is special-cased in regionRoutes.js to CLEAR that
// doc's `regions` array rather than storing this region's own id anywhere —
// see models/Region.js for why.
async function getOrCreateAllRegion() {
  return Region.findOneAndUpdate(
    { name: "All" },
    {
      $set: { isDefault: true, code: "ALL" },
      $setOnInsert: {
        description: "Always visible, regardless of a learner's own region.",
        color: "#64748b",
        order: -1,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

module.exports = { getOrCreateAllRegion };
