// seedDepartments.js (Run once: node seedDepartments.js)
const mongoose = require("mongoose");
const Department = require("./src/models/Department");
require("dotenv").config();

const seedDepts = [
  { 
    name: "iFILE", 
    code: "IFILE", 
    description: "Supervisory technology (SupTech) platform utilized by global central banks and regulators to collect, process, and automatically validate structured business data and regulatory financial filings." //
  },
  { 
    name: "iDEAL", 
    code: "IDEAL", 
    description: "Automated regulatory and prudential compliance reporting solution designed specifically for commercial banking, mutual funds, and BFSI financial institutions to manage ratio audits." //
  },
  { 
    name: "CARBON", 
    code: "CARBON", 
    description: "SaaS disclosure management and digital ESG reporting platform enabling enterprises to safely author, cross-reference, and execute structured automated XBRL/iXBRL filings for global capital market authorities." //
  },
  { 
    name: "DATATECH (MSME)", 
    code: "DATATECH", 
    description: "Core high-performance data engineering and automated validation framework layer focused on transforming financial raw assets into clean, auditable BSON and XML information standard formats." //
  }
];

mongoose.connect(process.env.MONGO_URI || process.env.DATABASE_URL)
  .then(async () => {
    console.log("📡 Connected to MongoDB. Syncing real department collections...");
    // Upsert by `code` instead of deleteMany+insertMany. The old delete-then-
    // reinsert approach handed every department a brand-new _id on every run
    // — any Module/DailyRead/News/User already referencing the old _id was
    // silently orphaned (that _id no longer resolves to any Department),
    // which is exactly why re-signing-up under the "same" department could
    // end up with an ID nothing else recognizes. Upserting preserves each
    // department's _id across repeated runs.
    const docs = await Promise.all(
      seedDepts.map((dept) =>
        Department.findOneAndUpdate(
          { code: dept.code.toLowerCase() },
          { $set: dept },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        )
      )
    );
    console.log("🚀 Real uniform departments synced successfully:", docs);
    process.exit();
  })
  .catch(err => {
    console.error("❌ Seeding failure exception:", err);
    process.exit(1);
  });