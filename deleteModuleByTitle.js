// deleteModuleByTitle.js
// Usage:
//   node deleteModuleByTitle.js "AI"            → dry run, shows what WOULD be deleted
//   node deleteModuleByTitle.js "AI" --confirm  → actually deletes
//
// Permanently deletes a Module (exact title match) and everything that
// references it: its Topics, its Cards (both directly module-owned and
// topic-owned), and per-user progress/rating/reset-log records. Nothing
// else is touched — other modules, categories, and regions are untouched.
require("dotenv").config();
const mongoose = require("mongoose");
const Module = require("./src/models/Module");
const Topic = require("./src/models/Topic");
const Card = require("./src/models/Card");
const UserModuleProgress = require("./src/models/UserModuleProgress");
const UserTopicProgress = require("./src/models/UserTopicProgress");
const UserCardProgress = require("./src/models/UserCardProgress");
const ModuleResetLog = require("./src/models/ModuleResetLog");
const ModuleRating = require("./src/models/ModuleRating");

const title = process.argv[2];
const confirmed = process.argv.includes("--confirm");

if (!title) {
  console.error('Usage: node deleteModuleByTitle.js "<exact module title>" [--confirm]');
  process.exit(1);
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI || process.env.DATABASE_URL);
  console.log(`📡 Connected to MongoDB (${mongoose.connection.name}).`);

  const modules = await Module.find({ title });
  if (modules.length === 0) {
    console.log(`No module found with title exactly "${title}". Nothing to do.`);
    await mongoose.disconnect();
    return;
  }
  if (modules.length > 1) {
    console.log(`⚠️  ${modules.length} modules match "${title}" exactly — aborting so nothing ambiguous gets deleted:`);
    modules.forEach(m => console.log(`   - ${m._id}`));
    await mongoose.disconnect();
    process.exit(1);
  }

  const mod = modules[0];
  const moduleId = mod._id;
  const topics = await Topic.find({ module_id: moduleId }).select("_id");
  const topicIds = topics.map(t => t._id);

  const [cardCount, moduleProgressCount, topicProgressCount, cardProgressCount, resetLogCount, ratingCount] = await Promise.all([
    Card.countDocuments({ $or: [{ module_id: moduleId }, { topic_id: { $in: topicIds } }] }),
    UserModuleProgress.countDocuments({ module_id: moduleId }),
    UserTopicProgress.countDocuments({ module_id: moduleId }),
    UserCardProgress.countDocuments({ module_id: moduleId }),
    ModuleResetLog.countDocuments({ module_id: moduleId }),
    ModuleRating.countDocuments({ module_id: moduleId }),
  ]);

  console.log(`\nFound module: "${mod.title}" (${moduleId})`);
  console.log(`  Topics:               ${topicIds.length}`);
  console.log(`  Cards:                ${cardCount}`);
  console.log(`  User module progress: ${moduleProgressCount}`);
  console.log(`  User topic progress:  ${topicProgressCount}`);
  console.log(`  User card progress:   ${cardProgressCount}`);
  console.log(`  Reset logs:           ${resetLogCount}`);
  console.log(`  Ratings:              ${ratingCount}`);

  if (!confirmed) {
    console.log("\n🔍 Dry run only — nothing deleted. Re-run with --confirm to actually delete all of the above.");
    await mongoose.disconnect();
    return;
  }

  await Card.deleteMany({ $or: [{ module_id: moduleId }, { topic_id: { $in: topicIds } }] });
  await Topic.deleteMany({ module_id: moduleId });
  await UserModuleProgress.deleteMany({ module_id: moduleId });
  await UserTopicProgress.deleteMany({ module_id: moduleId });
  await UserCardProgress.deleteMany({ module_id: moduleId });
  await ModuleResetLog.deleteMany({ module_id: moduleId });
  await ModuleRating.deleteMany({ module_id: moduleId });
  await Module.deleteOne({ _id: moduleId });

  console.log(`\n✅ Deleted module "${mod.title}" and all associated records.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("❌ Deletion failed:", err);
  process.exit(1);
});
