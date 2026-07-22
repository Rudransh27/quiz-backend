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
    name: "DATATECH", 
    code: "DATATECH", 
    description: "Core high-performance data engineering and automated validation framework layer focused on transforming financial raw assets into clean, auditable BSON and XML information standard formats." //
  }
];

mongoose.connect(process.env.MONGO_URI || process.env.DATABASE_URL)
  .then(async () => {
    console.log("📡 Connected to MongoDB. Syncing real department collections...");
    await Department.deleteMany({}); // Purana code parameters drop
    const docs = await Department.insertMany(seedDepts);
    console.log("🚀 Real uniform departments seeded successfully:", docs);
    process.exit();
  })
  .catch(err => {
    console.error("❌ Seeding failure exception:", err);
    process.exit(1);
  });