/**
 * IRIS Orbit — Sample Module Seed Script
 * Run once: node seed-modules.js
 * Creates demo modules with topics and cards for a rich learning experience.
 */
require("dotenv").config({ path: "./.env" });
const mongoose = require("mongoose");

const DB_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

// ── Minimal inline schemas (avoids model-registration conflicts) ──────────
const CardSchema = new mongoose.Schema({ card_type: String, module_id: mongoose.Schema.Types.ObjectId, topic_id: mongoose.Schema.Types.ObjectId, order: Number, content: mongoose.Schema.Types.Mixed }, { timestamps: true });
const TopicSchema = new mongoose.Schema({ title: String, description: String, module_id: mongoose.Schema.Types.ObjectId, order: Number, xpReward: Number }, { timestamps: true });
const ModuleSchema = new mongoose.Schema({ title: String, description: String, visibility: String, engineStrategy: String, hasTopics: Boolean, department: mongoose.Schema.Types.ObjectId, xpReward: Number, imageUrl: String }, { timestamps: true });
const DeptSchema = new mongoose.Schema({ name: String, code: String });

const Card   = mongoose.model("Card",       CardSchema);
const Topic  = mongoose.model("Topic",      TopicSchema);
const Module = mongoose.model("Module",     ModuleSchema);
const Dept   = mongoose.model("Department", DeptSchema);

// ── Seed data ─────────────────────────────────────────────────────────────
const MODULES = [
  {
    title: "XBRL Fundamentals",
    description: "Master the eXtensible Business Reporting Language — from taxonomy structure to filing compliance.",
    visibility: "Global",
    engineStrategy: "STANDARD",
    hasTopics: true,
    xpReward: 200,
    topics: [
      {
        title: "What is XBRL?",
        description: "History, purpose, and global adoption of the XBRL standard.",
        order: 1, xpReward: 40,
        cards: [
          { card_type: "knowledge", order: 1, content: { title: "XBRL Overview", body: "XBRL (eXtensible Business Reporting Language) is an open international standard for digital business reporting. It enables structured data exchange between companies, regulators, and analysts." } },
          { card_type: "knowledge", order: 2, content: { title: "Why XBRL Matters", body: "XBRL eliminates manual data re-entry, reduces reporting errors, and enables automated analysis of financial statements by regulators like SEC, ESMA, and MCA." } },
          { card_type: "quiz", order: 3, content: { question: "What does XBRL stand for?", options: ["eXtensible Business Reporting Language", "Extended Binary Report Layer", "External Business Record Ledger", "Enterprise Budget Review Logic"], correctIndex: 0, explanation: "XBRL stands for eXtensible Business Reporting Language — an open standard for structured financial reporting." } },
          { card_type: "quiz", order: 4, content: { question: "Which regulatory body mandates XBRL filing in the US?", options: ["IRS", "SEC", "FINRA", "CFTC"], correctIndex: 1, explanation: "The SEC (Securities and Exchange Commission) mandates XBRL-tagged filings for public companies." } },
        ]
      },
      {
        title: "XBRL Taxonomy Structure",
        description: "Understanding schemas, linkbases, and element definitions.",
        order: 2, xpReward: 60,
        cards: [
          { card_type: "knowledge", order: 1, content: { title: "What is a Taxonomy?", body: "An XBRL taxonomy is a standardized dictionary of reporting elements (concepts) defined in XML Schema. It includes labels, references, calculation rules, and presentation hierarchies." } },
          { card_type: "knowledge", order: 2, content: { title: "Linkbase Types", body: "There are 5 key linkbases: Label (human-readable names), Reference (regulatory citations), Calculation (arithmetic rules), Definition (dimensional relationships), Presentation (display hierarchy)." } },
          { card_type: "quiz", order: 3, content: { question: "Which linkbase defines the arithmetic relationships between XBRL elements?", options: ["Label linkbase", "Reference linkbase", "Calculation linkbase", "Presentation linkbase"], correctIndex: 2, explanation: "The Calculation linkbase defines arithmetic relationships — e.g., Assets = Liabilities + Equity." } },
          { card_type: "quiz", order: 4, content: { question: "What file format is used for XBRL taxonomy schemas?", options: ["JSON", "CSV", "XML Schema (XSD)", "YAML"], correctIndex: 2, explanation: "XBRL taxonomies use XML Schema Definition (.xsd) files to define the structure and constraints of reporting elements." } },
          { card_type: "quiz", order: 5, content: { question: "How many standard linkbase types exist in XBRL?", options: ["3", "4", "5", "6"], correctIndex: 2, explanation: "There are 5 standard linkbases: Label, Reference, Calculation, Definition, and Presentation." } },
        ]
      },
      {
        title: "XBRL Instance Documents",
        description: "Creating and validating XBRL instance documents for regulatory filing.",
        order: 3, xpReward: 70,
        cards: [
          { card_type: "knowledge", order: 1, content: { title: "Instance Document Structure", body: "An XBRL instance document is the actual filing that contains tagged financial data. It references a taxonomy and maps company-specific values to standardized XBRL concepts." } },
          { card_type: "knowledge", order: 2, content: { title: "Context and Units", body: "Every fact in an XBRL instance must have a Context (who, when) and a Unit (USD, shares, etc.). Contexts define the reporting entity and period." } },
          { card_type: "quiz", order: 3, content: { question: "What must every numerical fact in an XBRL instance document have?", options: ["A label and reference", "A context and a unit", "A schema and linkbase", "A namespace and prefix"], correctIndex: 1, explanation: "Every numerical fact requires both a Context (entity + period) and a Unit (currency, shares, etc.)." } },
        ]
      },
    ]
  },
  {
    title: "iFile Platform Essentials",
    description: "Navigate the IRIS iFile platform — from submission workflows to validation rules and audit trails.",
    visibility: "Global",
    engineStrategy: "STANDARD",
    hasTopics: true,
    xpReward: 150,
    topics: [
      {
        title: "Platform Overview",
        description: "Getting started with iFile — dashboard, navigation, and user roles.",
        order: 1, xpReward: 30,
        cards: [
          { card_type: "knowledge", order: 1, content: { title: "iFile Dashboard", body: "The iFile dashboard provides a centralized view of all filings, validation status, submission history, and regulatory deadlines. Roles include Preparer, Reviewer, Approver, and Regulator." } },
          { card_type: "quiz", order: 2, content: { question: "Which iFile role has final approval authority for a filing submission?", options: ["Preparer", "Reviewer", "Approver", "Validator"], correctIndex: 2, explanation: "The Approver role has the authority to digitally sign and submit the final filing to the regulatory body." } },
          { card_type: "quiz", order: 3, content: { question: "What does the iFile validation engine check?", options: ["Only arithmetic calculations", "Only schema compliance", "Business rules, arithmetic, and schema compliance", "Only regulatory deadlines"], correctIndex: 2, explanation: "iFile validates three dimensions: XML schema compliance, arithmetic calculation consistency, and business rule adherence." } },
        ]
      },
      {
        title: "Filing Workflow",
        description: "End-to-end submission lifecycle from data entry to regulatory acknowledgment.",
        order: 2, xpReward: 50,
        cards: [
          { card_type: "knowledge", order: 1, content: { title: "Submission Lifecycle", body: "A filing moves through: Draft → Validate → Review → Approve → Submit → Acknowledge. Each stage has specific access controls and audit log entries." } },
          { card_type: "knowledge", order: 2, content: { title: "Validation Errors vs Warnings", body: "Errors block submission — they indicate structural or calculation failures. Warnings are advisory — the filing can proceed but issues should be reviewed." } },
          { card_type: "quiz", order: 3, content: { question: "Which filing status allows editing by the Preparer?", options: ["Submitted", "Approved", "Draft", "Acknowledged"], correctIndex: 2, explanation: "Only filings in 'Draft' status can be edited. Once submitted, the filing is locked for audit integrity." } },
          { card_type: "quiz", order: 4, content: { question: "What happens when a validation Error (not Warning) is detected?", options: ["Filing proceeds with a note", "Filing is blocked from submission", "Filing is auto-corrected", "Regulator is notified"], correctIndex: 1, explanation: "Validation Errors are blocking — the filing cannot be submitted until all errors are resolved." } },
        ]
      },
    ]
  },
  {
    title: "Financial Reporting Compliance",
    description: "Deep dive into IndAS, IFRS, and GAAP reporting requirements for regulatory compliance.",
    visibility: "Global",
    engineStrategy: "STANDARD",
    hasTopics: true,
    xpReward: 180,
    topics: [
      {
        title: "IndAS vs IFRS",
        description: "Key differences and convergence between Indian Accounting Standards and IFRS.",
        order: 1, xpReward: 50,
        cards: [
          { card_type: "knowledge", order: 1, content: { title: "Convergence Journey", body: "India's Ministry of Corporate Affairs converged Indian GAAP with IFRS through IndAS (Indian Accounting Standards), effective for listed companies from April 2016." } },
          { card_type: "quiz", order: 2, content: { question: "IndAS is converged with which international standard?", options: ["US GAAP", "IFRS", "UK GAAP", "ASEAN GAAP"], correctIndex: 1, explanation: "IndAS is converged with IFRS (International Financial Reporting Standards) as issued by the IASB." } },
          { card_type: "quiz", order: 3, content: { question: "When did Phase 1 IndAS applicability begin for listed companies in India?", options: ["April 2014", "April 2016", "April 2018", "April 2020"], correctIndex: 1, explanation: "Phase 1 of IndAS applicability for listed companies (Net worth ≥ ₹500 crore) began from April 1, 2016." } },
        ]
      },
      {
        title: "Revenue Recognition (IndAS 115)",
        description: "5-step model for revenue recognition under IndAS 115 / IFRS 15.",
        order: 2, xpReward: 60,
        cards: [
          { card_type: "knowledge", order: 1, content: { title: "The 5-Step Model", body: "Step 1: Identify the contract. Step 2: Identify performance obligations. Step 3: Determine transaction price. Step 4: Allocate price to obligations. Step 5: Recognize revenue when/as obligations satisfied." } },
          { card_type: "quiz", order: 2, content: { question: "Under IndAS 115, how many steps are in the revenue recognition model?", options: ["3", "4", "5", "6"], correctIndex: 2, explanation: "IndAS 115 uses a 5-step model for revenue recognition, aligned with IFRS 15." } },
          { card_type: "quiz", order: 3, content: { question: "Revenue is recognized at the point when:", options: ["Invoice is raised", "Payment is received", "Performance obligation is satisfied", "Contract is signed"], correctIndex: 2, explanation: "Revenue is recognized when (or as) a performance obligation is satisfied — i.e., control of goods/services transfers to the customer." } },
        ]
      },
    ]
  },
  {
    title: "Data Quality & Validation",
    description: "Best practices for ensuring data accuracy in structured reporting environments.",
    visibility: "Global",
    engineStrategy: "EXPRESS_FLAT",
    hasTopics: false,
    xpReward: 100,
    cards: [
      { card_type: "knowledge", order: 1, content: { title: "Data Quality Dimensions", body: "Key dimensions: Accuracy (correct values), Completeness (no missing fields), Consistency (same across systems), Timeliness (filed within deadlines), Validity (within allowed ranges)." } },
      { card_type: "quiz", order: 2, content: { question: "Which data quality dimension ensures values are within permitted ranges?", options: ["Accuracy", "Completeness", "Validity", "Timeliness"], correctIndex: 2, explanation: "Validity ensures that data values conform to permitted formats and value ranges defined in the taxonomy." } },
      { card_type: "knowledge", order: 3, content: { title: "XBRL Validation Rules", body: "XBRL validation checks syntax (well-formed XML), schema (correct element usage), calculations (arithmetic balances), and business rules (regulatory consistency checks)." } },
      { card_type: "quiz", order: 4, content: { question: "What type of XBRL validation checks if Assets = Liabilities + Equity?", options: ["Schema validation", "Syntax validation", "Calculation validation", "Business rule validation"], correctIndex: 2, explanation: "Calculation validation verifies arithmetic relationships defined in the Calculation linkbase, such as balance sheet equations." } },
      { card_type: "quiz", order: 5, content: { question: "A validation Warning in iFile:", options: ["Blocks submission", "Auto-corrects the value", "Is advisory and doesn't block submission", "Requires regulator approval"], correctIndex: 2, explanation: "Warnings are advisory — they highlight potential issues but do not prevent submission. Errors block submission." } },
      { card_type: "knowledge", order: 6, content: { title: "Common XBRL Errors", body: "Top errors: wrong period context, missing required elements, arithmetic mismatches, using deprecated concepts, and namespace prefix conflicts." } },
    ]
  },
  {
    title: "RegTech & Regulatory Technology",
    description: "How technology is transforming compliance — AI, automation, and real-time reporting.",
    visibility: "Global",
    engineStrategy: "EXPRESS_FLAT",
    hasTopics: false,
    xpReward: 120,
    cards: [
      { card_type: "knowledge", order: 1, content: { title: "What is RegTech?", body: "RegTech (Regulatory Technology) uses technology — AI, blockchain, cloud computing — to help firms comply with regulations more efficiently, accurately, and cost-effectively." } },
      { card_type: "quiz", order: 2, content: { question: "RegTech primarily aims to:", options: ["Replace human regulators", "Make compliance more efficient and accurate", "Eliminate all regulations", "Automate tax evasion"], correctIndex: 1, explanation: "RegTech uses technology to make regulatory compliance faster, more accurate, and cost-effective — not to circumvent regulations." } },
      { card_type: "knowledge", order: 3, content: { title: "AI in Financial Compliance", body: "Machine learning models analyze transaction patterns to detect anomalies, flag suspicious activity, and predict compliance risks before they materialize." } },
      { card_type: "quiz", order: 4, content: { question: "Which technology is commonly used in RegTech for pattern detection?", options: ["Blockchain only", "Machine Learning", "Spreadsheets", "Manual audit"], correctIndex: 1, explanation: "Machine Learning enables automated pattern recognition across large datasets, identifying compliance risks and anomalies." } },
      { card_type: "knowledge", order: 5, content: { title: "Real-time Regulatory Reporting", body: "Next-generation regulation moves toward continuous real-time reporting rather than periodic filings. This requires API-connected systems, structured data standards, and automated validation pipelines." } },
    ]
  },
];

async function seed() {
  await mongoose.connect(DB_URI);
  console.log("✅ Connected to MongoDB");

  // Find any department to assign if needed
  const anyDept = await Dept.findOne();

  let created = 0;

  for (const modDef of MODULES) {
    const existing = await Module.findOne({ title: modDef.title });
    if (existing) {
      console.log(`⏭️  Skipping "${modDef.title}" — already exists`);
      continue;
    }

    const { topics: topicDefs, cards: flatCards, ...modData } = modDef;
    if (anyDept && !modData.department) modData.department = anyDept._id;

    const mod = await Module.create(modData);
    console.log(`📦 Created module: ${mod.title}`);
    created++;

    if (topicDefs) {
      for (const topicDef of topicDefs) {
        const { cards: cardDefs, ...topicData } = topicDef;
        const topic = await Topic.create({ ...topicData, module_id: mod._id });

        for (const cardDef of cardDefs) {
          await Card.create({ ...cardDef, module_id: mod._id, topic_id: topic._id });
        }
        console.log(`  └─ Topic: "${topic.title}" (${cardDefs.length} cards)`);
      }
    }

    if (flatCards) {
      for (const cardDef of flatCards) {
        await Card.create({ ...cardDef, module_id: mod._id });
      }
      console.log(`  └─ ${flatCards.length} flat cards`);
    }
  }

  console.log(`\n✅ Seed complete — ${created} new modules created`);
  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error("❌ Seed failed:", err.message);
  process.exit(1);
});
