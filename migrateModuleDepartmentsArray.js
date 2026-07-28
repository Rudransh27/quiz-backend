// migrateModuleDepartmentsArray.js
// One-time backfill for the Module.department (singular ObjectId) ->
// Module.departments (array) schema change. For every Module still holding
// the old `department` field, sets `departments: [department]` (or `[]` for
// a Global module with no department) and unsets `department`. Idempotent —
// a module that already has a non-empty `departments` array and no
// `department` field is left untouched, so re-running this is always safe.
//
// USAGE
//
//   node migrateModuleDepartmentsArray.js
//
require("dotenv").config();
const mongoose = require("mongoose");

async function main() {
  await mongoose.connect(process.env.MONGO_URI || process.env.DATABASE_URL);
  console.log("Connected to MongoDB.\n");

  const db = mongoose.connection.db;
  const modules = db.collection("modules");

  const staleModules = await modules.find({ department: { $exists: true } }).toArray();
  console.log(`Found ${staleModules.length} module(s) still holding the old singular "department" field.`);

  let migrated = 0;
  for (const mod of staleModules) {
    const departments = mod.department ? [mod.department] : [];
    await modules.updateOne(
      { _id: mod._id },
      { $set: { departments }, $unset: { department: "" } }
    );
    migrated++;
  }

  console.log(`\nMigrated ${migrated} module(s) to the new "departments" array field.`);

  const remaining = await modules.countDocuments({ department: { $exists: true } });
  console.log(`Modules still holding "department": ${remaining} (should be 0).`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Migration script failed:", err);
  process.exit(1);
});
