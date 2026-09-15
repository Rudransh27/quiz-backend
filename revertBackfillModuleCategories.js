// revertBackfillModuleCategories.js
// Undoes backfillModuleCategories.js: sets categoryId back to null on every
// Module currently pointing at the "Uncategorized" bucket, restoring them to
// the exact same "no category" state they were in before that backfill ran.
//
// Usage:
//   node revertBackfillModuleCategories.js            → dry run, shows what WOULD change
//   node revertBackfillModuleCategories.js --confirm  → actually reverts
//
// Caveat: this reverts EVERY module currently set to Uncategorized, not just
// the ones the original backfill touched (no per-module log was kept). If any
// module was deliberately left/assigned to Uncategorized through the admin UI
// after the backfill ran, this will also null out its categoryId. Review the
// dry-run list before confirming.
require("dotenv").config();
const mongoose = require("mongoose");
const Module = require("./src/models/Module");
const Category = require("./src/models/Category");

const confirmed = process.argv.includes("--confirm");

async function main() {
  await mongoose.connect(process.env.MONGO_URI || process.env.DATABASE_URL);
  console.log(`📡 Connected to MongoDB (${mongoose.connection.name}).`);

  const uncategorized = await Category.findOne({ isDefault: true });
  if (!uncategorized) {
    console.log('No "Uncategorized" category exists — nothing to revert.');
    await mongoose.disconnect();
    return;
  }

  const affected = await Module.find({ categoryId: uncategorized._id }).select("_id title");
  console.log(`\nUncategorized bucket: ${uncategorized._id}`);
  console.log(`Modules currently set to Uncategorized: ${affected.length}`);
  affected.forEach(m => console.log(`   - ${m.title} (${m._id})`));

  if (!confirmed) {
    console.log("\n🔍 Dry run only — nothing changed. Re-run with --confirm to set categoryId back to null on all of the above.");
    await mongoose.disconnect();
    return;
  }

  const result = await Module.updateMany(
    { categoryId: uncategorized._id },
    { $set: { categoryId: null } }
  );
  console.log(`\n✅ Reverted ${result.modifiedCount} module(s) back to categoryId: null.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("❌ Revert failed:", err);
  process.exit(1);
});
