// src/utils/defaultCategory.js
const Category = require("../models/Category");

// 🔒 Every Module always resolves to a real Category — a module the admin
// never explicitly tagged falls back to this permanent "Uncategorized"
// bucket instead of sitting at categoryId:null. Lazily created on first use
// (upsert by isDefault, so it's safe to call from anywhere, anytime, and
// never creates a second one).
async function getOrCreateUncategorizedCategory() {
  // Queried by `name` (not `isDefault`) so this can never collide with the
  // unique `name` index if a document named "Uncategorized" somehow already
  // exists — it's simply promoted to the default bucket instead.
  // 🌍 Always Global — every user must always be able to see and use the
  // fallback bucket, regardless of their own department/team.
  return Category.findOneAndUpdate(
    { name: "Uncategorized" },
    {
      $set: { isDefault: true, visibility: "Global", departments: [], targetTeams: [] },
      $setOnInsert: { description: "Modules that haven't been assigned to a category yet.", order: 9999 },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

module.exports = { getOrCreateUncategorizedCategory };
