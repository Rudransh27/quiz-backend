// backfillModuleCategories.js (Run once against production: node backfillModuleCategories.js)
//
// Safe to run any number of times. Ensures the permanent "Uncategorized"
// bucket exists, then assigns it to any pre-existing Module that has no
// categoryId at all — so nothing already in the database disappears from
// the new tag-grouped Learn page after this deploy. Does NOT touch Topics,
// Cards, or any existing module content — categoryId is the only field
// written here.
require("dotenv").config();
const mongoose = require("mongoose");
const Module = require("./src/models/Module");
const { getOrCreateUncategorizedCategory } = require("./src/utils/defaultCategory");

async function main() {
  await mongoose.connect(process.env.MONGO_URI || process.env.DATABASE_URL);
  console.log(`📡 Connected to MongoDB (${mongoose.connection.name}). Backfilling module categories...`);

  const uncategorized = await getOrCreateUncategorizedCategory();
  console.log(`🏷️  Uncategorized bucket ready: ${uncategorized._id}`);

  const missing = await Module.updateMany(
    { categoryId: { $exists: false } },
    { $set: { categoryId: uncategorized._id } }
  );
  const nullValued = await Module.updateMany(
    { categoryId: null },
    { $set: { categoryId: uncategorized._id } }
  );

  console.log(`🧹 Backfilled ${missing.modifiedCount + nullValued.modifiedCount} pre-existing module(s) to Uncategorized.`);
  console.log("✅ Done. Re-tag them from Admin → Tags whenever convenient — this only prevents them from disappearing.");
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("❌ Backfill failed:", err);
  process.exit(1);
});
