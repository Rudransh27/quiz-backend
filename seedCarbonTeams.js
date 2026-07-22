// quiz-backend/seedCarbonTeams.js (Run once: node seedCarbonTeams.js)
const mongoose = require("mongoose");
const dotenv = require("dotenv");
const Department = require("./src/models/Department");
const Team = require("./src/models/Team");

dotenv.config();

const carbonTeams = [
  { name: "Sales", code: "SALES" },
  { name: "Support", code: "SUPPORT" },
  { name: "Product Engineering, Testing & Analytics", code: "PRODUCT_ENG_TESTING_ANALYTICS" },
  { name: "Services", code: "SERVICES" },
  { name: "Formatting & OCR", code: "FORMATTING_OCR" },
  { name: "Functional", code: "FUNCTIONAL" },
  { name: "Marketing (other than ABM, SDR)", code: "MARKETING" },
  { name: "ABM", code: "ABM" },
  { name: "SDR", code: "SDR" },
  { name: "CEM", code: "CEM" },
  { name: "Operations", code: "OPERATIONS" },
  { name: "Council members", code: "COUNCIL_MEMBERS" }
];

const seedCarbonTeams = async () => {
  try {
    console.log("📡 Connecting to database cluster...");
    await mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017/xbrl_app");
    console.log("✅ Database connected successfully.");

    const carbonDept = await Department.findOne({ name: "CARBON" });
    if (!carbonDept) {
      throw new Error("Carbon department not found. Run seedDepartments.js first.");
    }
    console.log(`🏢 Found Carbon Department (id: ${carbonDept._id}).`);

    for (const team of carbonTeams) {
      const existing = await Team.findOne({ department_id: carbonDept._id, code: team.code });
      if (existing) {
        console.log(`↷ Skipped (already exists): ${team.name}`);
        continue;
      }
      await Team.create({
        name: team.name,
        code: team.code,
        department_id: carbonDept._id
      });
      console.log(`👥 Added: ${team.name}`);
    }

    console.log("\n🏆 SUCCESS: Carbon teams seeding complete!");
    process.exit(0);
  } catch (err) {
    console.error("❌ Seeding failed:", err.message);
    process.exit(1);
  }
};

seedCarbonTeams();
