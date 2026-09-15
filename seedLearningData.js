// quiz-backend/seedLearningData.js
//
// Seeds Module -> Topic -> Card documents from learningData.json (or another
// file in the same shape, passed as the first CLI arg).
//
// Usage:
//   node seedLearningData.js                        (uses ./learningData.json)
//   node seedLearningData.js myFile.json
//   node seedLearningData.js --force                (delete + recreate modules that already exist by title)
//   node seedLearningData.js myFile.json --force
const path = require("path");
const dotenv = require("dotenv");
const mongoose = require("mongoose");

dotenv.config();

const Module = require("./src/models/Module");
const Topic = require("./src/models/Topic");
const Card = require("./src/models/Card");
const Department = require("./src/models/Department");
const { getOrCreateUncategorizedCategory } = require("./src/utils/defaultCategory");

const args = process.argv.slice(2);
const force = args.includes("--force");
const fileArg = args.find((a) => !a.startsWith("--"));
const dataFile = path.resolve(__dirname, fileArg || "learningData.json");

// Mirrors resolveModuleOrder() in src/routes/moduleRoutes.js — append at the
// end of whatever's already in that category so seeded modules don't collide
// with (or jump ahead of) modules created through the admin UI.
async function nextOrderInCategory(categoryId) {
  const lastInCategory = await Module.findOne({ categoryId }).sort({ order: -1 }).select("order").lean();
  return lastInCategory ? (Number(lastInCategory.order) || 0) + 1 : 0;
}

// Purges a module and everything under it (topics, their cards, and any
// flat module-level cards) before it gets recreated under --force.
async function purgeModuleByTitle(title) {
  const existing = await Module.findOne({ title });
  if (!existing) return;

  const topics = await Topic.find({ module_id: existing._id });
  const topicIds = topics.map((t) => t._id);
  if (topicIds.length) await Card.deleteMany({ topic_id: { $in: topicIds } });
  await Card.deleteMany({ module_id: existing._id });
  await Topic.deleteMany({ module_id: existing._id });
  await Module.deleteOne({ _id: existing._id });
}

async function resolveVisibility(departmentId) {
  if (!departmentId) return { visibility: "Global", departments: [] };

  const dept = await Department.findById(departmentId).select("_id").lean();
  if (!dept) {
    console.warn(`   ⚠️  Department ${departmentId} not found — falling back to Global visibility.`);
    return { visibility: "Global", departments: [] };
  }
  return { visibility: "Departmental", departments: [dept._id] };
}

async function seedModuleDef(moduleDef) {
  const existing = await Module.findOne({ title: moduleDef.title });
  if (existing) {
    if (!force) {
      console.log(`⏭️  Skipping "${moduleDef.title}" — already exists (pass --force to replace it).`);
      return { created: false };
    }
    console.log(`🧹 --force: purging existing "${moduleDef.title}" before reseeding...`);
    await purgeModuleByTitle(moduleDef.title);
  }

  const { visibility, departments } = await resolveVisibility(moduleDef.department);
  const category = await getOrCreateUncategorizedCategory();
  const order = await nextOrderInCategory(category._id);

  const hasTopics = Array.isArray(moduleDef.topics) && moduleDef.topics.length > 0;

  const savedModule = await Module.create({
    title: moduleDef.title,
    description: moduleDef.description,
    imageUrl: moduleDef.imageUrl || "",
    visibility,
    departments,
    hasTopics,
    categoryId: category._id,
    order,
  });
  console.log(`📦 Created module: "${savedModule.title}" (${visibility})`);

  let topicCount = 0;
  let cardCount = 0;

  if (hasTopics) {
    for (const topicDef of moduleDef.topics) {
      const savedTopic = await Topic.create({
        module_id: savedModule._id,
        title: topicDef.title,
        description: topicDef.description,
        topicOrder: topicDef.topicOrder,
      });
      topicCount++;

      const cards = (topicDef.cards || []).map((cardDef) => ({
        topic_id: savedTopic._id,
        card_type: cardDef.card_type,
        cardOrder: cardDef.cardOrder,
        imageUrl: cardDef.imageUrl || "",
        content: cardDef.content,
      }));
      if (cards.length) {
        await Card.insertMany(cards);
        cardCount += cards.length;
      }
      console.log(`   └─ Topic: "${savedTopic.title}" (${cards.length} cards)`);
    }
  } else if (Array.isArray(moduleDef.cards) && moduleDef.cards.length) {
    const cards = moduleDef.cards.map((cardDef) => ({
      module_id: savedModule._id,
      card_type: cardDef.card_type,
      cardOrder: cardDef.cardOrder,
      imageUrl: cardDef.imageUrl || "",
      content: cardDef.content,
    }));
    await Card.insertMany(cards);
    cardCount += cards.length;
    console.log(`   └─ ${cards.length} flat cards`);
  }

  return { created: true, topicCount, cardCount };
}

async function run() {
  console.log(`📄 Loading learning data from ${dataFile}`);
  const moduleDefs = require(dataFile);
  if (!Array.isArray(moduleDefs)) {
    throw new Error("Expected the data file to export an array of module definitions.");
  }

  console.log("📡 Connecting to database...");
  await mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017/xbrl_app");
  console.log("✅ Database connected.");

  let modulesCreated = 0;
  let topicsCreated = 0;
  let cardsCreated = 0;

  for (const moduleDef of moduleDefs) {
    const result = await seedModuleDef(moduleDef);
    if (result.created) {
      modulesCreated++;
      topicsCreated += result.topicCount || 0;
      cardsCreated += result.cardCount || 0;
    }
  }

  console.log("\n==================================================");
  console.log("🏆 Seed complete");
  console.log(`📦 Modules created: ${modulesCreated}`);
  console.log(`🗂️ Topics created:  ${topicsCreated}`);
  console.log(`📄 Cards created:   ${cardsCreated}`);
  console.log("==================================================\n");
}

run()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error("❌ Seed failed:", err);
    process.exit(1);
  });
