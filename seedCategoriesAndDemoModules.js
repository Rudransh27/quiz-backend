// seedCategoriesAndDemoModules.js (Run once: node seedCategoriesAndDemoModules.js)
//
// Seeds the Category ("tag") taxonomy plus one dummy demo Module per row of
// the module→tag mapping table, and backfills any existing Module that has
// no categoryId at all to the permanent "Uncategorized" bucket. Idempotent —
// upserts by name (Category) / title (Module), safe to re-run.
require("dotenv").config();
const mongoose = require("mongoose");
const Category = require("./src/models/Category");
const Module = require("./src/models/Module");
const Card = require("./src/models/Card");
const { getOrCreateUncategorizedCategory } = require("./src/utils/defaultCategory");

const CATEGORY_NAMES = [
  "Onboarding",
  "Foundation",
  "Product",
  "Market",
  "Competitor landscape",
  "IPO",
  "Sales Pitch",
  "AIUS filing universe",
];

// title -> category name, exactly per the requested mapping table.
const MODULE_TO_CATEGORY = [
  ["Detect my anomalies for me", "AIUS filing universe"],
  ['What does "Tech Stack" in Finance Look Like?', "Foundation"],
  ["3 Siblings - ERP v/s DM v/s Consol (finance Automation)", "Foundation"],
  ["We Sell ESG But Do We Really Get It", "Foundation"],
  ["Know your Competitor – F19", "Competitor landscape"],
  ['IPO - Going public 101 [AKA S1 and Done]', "IPO"],
  ["Beyond the Mandate", "Market"],
  ["IRIS in 10 Minutes", "Onboarding"],
  ["Meet the team", "Onboarding"],
  ["Speak like an IRISian", "Onboarding"],
  ["Numbers 101", "Onboarding"],
  ["Brace yourself for the filing season", "Onboarding"],
  ["Under the Hood – Tech Architecture", "Product"],
  ["Scaling - why is this the most under rated feature?", "Product"],
  ["Pitch Refinement", "Sales Pitch"],
  ["IFRS 18", "Market"],
  ["Know your Competitor – Inscope", "Competitor landscape"],
];

async function main() {
  await mongoose.connect(process.env.MONGO_URI || process.env.DATABASE_URL);
  console.log("📡 Connected to MongoDB. Seeding categories + demo modules...");

  // 1. Seed the real categories (upsert by name).
  const categoryByName = {};
  for (let i = 0; i < CATEGORY_NAMES.length; i++) {
    const name = CATEGORY_NAMES[i];
    const doc = await Category.findOneAndUpdate(
      { name },
      { $setOnInsert: { name, description: "", order: i } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    categoryByName[name] = doc;
  }

  // 2. Seed the permanent "Uncategorized" fallback bucket.
  const uncategorized = await getOrCreateUncategorizedCategory();
  console.log(`🏷️  Categories ready: ${Object.keys(categoryByName).join(", ")}, Uncategorized`);

  // 3. Seed one dummy demo module per mapping row (upsert by title).
  let createdCount = 0;
  for (const [title, categoryName] of MODULE_TO_CATEGORY) {
    const category = categoryByName[categoryName];
    if (!category) {
      console.warn(`⚠️  Skipping "${title}" — unknown category "${categoryName}"`);
      continue;
    }

    const existing = await Module.findOne({ title });
    if (existing) {
      // Keep an already-existing module's tag in sync with the mapping
      // table too, in case this script is re-run after edits.
      if (!existing.categoryId || existing.categoryId.toString() !== category._id.toString()) {
        existing.categoryId = category._id;
        await existing.save();
      }
      continue;
    }

    const newModule = await Module.create({
      title,
      description: `Demo module for the "${categoryName}" tag.`,
      imageUrl: "https://example.com/images/default-xbrl-module.png",
      estimatedTime: 10,
      hasTopics: false,
      engineStrategy: "EXPRESS_FLAT",
      moduleType: "standard",
      visibility: "Global",
      departments: [],
      targetTeams: [],
      categoryId: category._id,
    });

    await Card.create({
      module_id: newModule._id,
      card_type: "knowledge",
      cardOrder: 1,
      content: {
        title,
        text: `This is placeholder content for the demo module "${title}", tagged under "${categoryName}".`,
      },
    });

    createdCount++;
  }
  console.log(`🚀 Demo modules created: ${createdCount} (of ${MODULE_TO_CATEGORY.length} mapping rows)`);

  // 4. Backfill: any pre-existing module with no categoryId at all falls
  // back to Uncategorized, so nothing already in the system silently
  // disappears from the new tag-grouped Learn page.
  const backfillResult = await Module.updateMany(
    { categoryId: { $exists: false } },
    { $set: { categoryId: uncategorized._id } }
  );
  const backfillResult2 = await Module.updateMany(
    { categoryId: null },
    { $set: { categoryId: uncategorized._id } }
  );
  console.log(`🧹 Backfilled ${backfillResult.modifiedCount + backfillResult2.modifiedCount} pre-existing module(s) to Uncategorized.`);

  console.log("✅ Done.");
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("❌ Seeding failure:", err);
  process.exit(1);
});
