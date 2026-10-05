// scripts/seed-demo-prepost.js
//
// Seeds DEMO Pre/Post checks so the Learn → Path → Pre-check → modules →
// Post-check flow can be tested end to end. For each target Path it:
//   1. adds 4 "[Demo] …" bank questions per module (2 easy + 2 medium),
//   2. generates the Pre/Post test with the real engine (disjoint,
//      difficulty-paired, 2 per module), locks it, and
//   3. turns the Path's Pre/Post check on.
//
// LOCAL DATABASES ONLY — refuses to run unless MONGO_URI points at
// localhost/127.0.0.1 (pass --allow-remote to override, never on prod).
//
//   node scripts/seed-demo-prepost.js                     # dry run
//   node scripts/seed-demo-prepost.js --apply             # seed Onboarding + Foundation
//   node scripts/seed-demo-prepost.js --apply --path="Onboarding"
//   node scripts/seed-demo-prepost.js --delete            # remove everything it added
require("dotenv").config({ quiet: true });
const mongoose = require("mongoose");
const Path = require("../src/models/Path");
const Module = require("../src/models/Module");
const BankQuestion = require("../src/models/BankQuestion");
const AssessmentForm = require("../src/models/AssessmentForm");
const AssessmentAttempt = require("../src/models/AssessmentAttempt");
const forms = require("../src/services/formGenerator");

const DEMO = "[Demo] ";
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => (args.find((a) => a.startsWith(`--${name}=`)) || "").split("=").slice(1).join("=");
const APPLY = flag("apply");
const DELETE = flag("delete");
const PATH_NAMES = opt("path") ? opt("path").split(",").map((s) => s.trim()) : ["Onboarding", "Foundation"];

// q: [question, [options], correctIndex, explanation, difficulty]
const BANK = [
  { match: /IRIS in 10 Minutes/i, qs: [
    ["What does XBRL stand for?", ["eXtensible Business Reporting Language", "eXternal Banking Record Ledger", "eXtended Budget Review List", "eXact Business Ratio Logic"], 0, "XBRL = eXtensible Business Reporting Language.", "easy"],
    ["XBRL is mainly used to…", ["Exchange business and financial reports as structured data", "Design company websites", "Encrypt email", "Run payroll"], 0, "It turns reports into machine-readable data.", "easy"],
    ["Why do regulators prefer XBRL filings over PDFs?", ["The data can be checked and compared automatically", "PDFs cannot be printed", "XBRL files are always smaller", "XBRL hides the numbers"], 0, "Structured data can be validated and analysed by software.", "medium"],
    ["Which of these is a typical XBRL filing?", ["A company's annual financial statements", "A holiday photo album", "A team chat log", "A product brochure"], 0, "Financial statements are the classic XBRL use case.", "medium"],
  ] },
  { match: /Meet the team/i, qs: [
    ["You're unsure who owns a task. What's the best first step?", ["Ask your manager or team lead", "Wait until someone notices", "Do nothing", "Email the whole company"], 0, "Your lead can point you to the right owner quickly.", "easy"],
    ["What helps a new teammate settle in fastest?", ["Knowing who to go to for what", "Working alone without questions", "Skipping team meetings", "Avoiding introductions"], 0, "A clear map of people and roles speeds everything up.", "easy"],
    ["A colleague from another team needs your input. Good practice is to…", ["Reply with what you know and loop in the right owner", "Ignore it — it isn't your team", "Forward it without comment", "Answer only after a week"], 0, "Help, and connect them to the owner when it isn't you.", "medium"],
    ["Why do teams share a single tracker for work?", ["So everyone sees status and priorities in one place", "To make work slower", "Because email is banned", "Only for managers"], 0, "One shared source of truth avoids duplicate work.", "medium"],
  ] },
  { match: /Speak like an IRISian/i, qs: [
    ["In XBRL, a 'taxonomy' is…", ["A dictionary of reporting concepts and their relationships", "A type of tax return", "A spreadsheet macro", "A filing fee"], 0, "The taxonomy defines the concepts a report can use.", "easy"],
    ["'Tagging' a number in a report means…", ["Linking it to a concept from the taxonomy", "Highlighting it in yellow", "Deleting it", "Rounding it"], 0, "Each tagged fact points to a defined concept.", "easy"],
    ["An XBRL 'instance document' contains…", ["The actual reported facts for one filing", "Only the taxonomy rules", "The company logo", "User passwords"], 0, "The instance holds the facts; the taxonomy defines them.", "medium"],
    ["What is a 'validation rule' used for?", ["Catching errors and inconsistencies before filing", "Changing the report's font", "Sending invoices", "Booking meetings"], 0, "Validation checks the data against the rules.", "medium"],
  ] },
  { match: /Numbers 101/i, qs: [
    ["Revenue minus expenses equals…", ["Profit (or loss)", "Assets", "Equity", "Cash in hand"], 0, "Profit = revenue − expenses.", "easy"],
    ["Which one is a liability?", ["A bank loan the company must repay", "Cash in the bank", "Office equipment", "Money customers owe the company"], 0, "A liability is an amount the company owes.", "easy"],
    ["Revenue is 200 and costs are 150. What is the profit margin?", ["25%", "50%", "75%", "33%"], 0, "Profit 50 ÷ revenue 200 = 25%.", "medium"],
    ["Assets = Liabilities + …", ["Equity", "Revenue", "Expenses", "Dividends"], 0, "The accounting equation: Assets = Liabilities + Equity.", "medium"],
  ] },
  { match: /filing season/i, qs: [
    ["What is a 'filing deadline'?", ["The last date a report can be submitted to the regulator", "The day the office closes", "A software update date", "A team holiday"], 0, "Missing it can mean penalties for the client.", "easy"],
    ["The best time to validate a filing is…", ["Early, well before the deadline", "Only on the deadline day", "After it is submitted", "Never — validation is optional"], 0, "Early validation leaves time to fix issues.", "easy"],
    ["During peak season, what keeps a client filing on track?", ["A clear checklist with owners and dates", "Starting the day before", "Skipping reviews", "Working without updates"], 0, "Owners + dates make bottlenecks visible early.", "medium"],
    ["A validation error appears the day before the deadline. First step?", ["Read the error, find the affected fact and fix it", "Submit anyway", "Delete the report", "Wait for the next season"], 0, "Most errors point straight at the fact to fix.", "medium"],
  ] },
  { match: /Tech Stack/i, qs: [
    ["Which system usually records a company's day-to-day transactions?", ["ERP", "A presentation tool", "An email client", "A chat app"], 0, "ERP systems run daily accounting and operations.", "easy"],
    ["Why does finance automate reporting?", ["Fewer manual errors and faster closes", "To use more paper", "To avoid audits", "To hide numbers"], 0, "Automation cuts errors and time.", "easy"],
    ["Data moves from ERP into reporting tools mainly to…", ["Prepare consolidated, tagged reports", "Make the ERP slower", "Delete old records", "Change tax rates"], 0, "Reporting tools turn ledger data into filings.", "medium"],
    ["A 'single source of truth' for finance data means…", ["Everyone reports from the same governed data", "Each team keeps its own copy", "Data lives only in email", "Numbers are typed again each time"], 0, "One governed source avoids conflicting numbers.", "medium"],
  ] },
  { match: /ERP v\/s DM v\/s Consol/i, qs: [
    ["What does a consolidation tool do?", ["Combines results of several entities into group figures", "Sends marketing email", "Stores HR files", "Designs logos"], 0, "Consolidation rolls up subsidiaries into group accounts.", "easy"],
    ["Which tool handles daily bookkeeping?", ["ERP", "Consolidation", "Disclosure management", "A web browser"], 0, "ERP is the transactional system.", "easy"],
    ["Disclosure management (DM) mainly helps to…", ["Assemble and tag the final report document", "Pay suppliers", "Track inventory", "Manage payroll"], 0, "DM builds the narrative + numbers report.", "medium"],
    ["Intercompany balances are eliminated during…", ["Consolidation", "Payroll", "Invoicing", "Recruiting"], 0, "Eliminations happen when combining entities.", "medium"],
  ] },
  { match: /ESG/i, qs: [
    ["ESG stands for…", ["Environmental, Social and Governance", "Earnings, Sales and Growth", "Equity, Stock and Gains", "Energy, Safety and Goods"], 0, "Environmental, Social and Governance.", "easy"],
    ["Which is an 'Environmental' metric?", ["Carbon emissions", "Board size", "Employee training hours", "Share price"], 0, "Emissions are a core environmental measure.", "easy"],
    ["Why are ESG reports increasingly tagged in XBRL?", ["So sustainability data can be compared like financial data", "To make them longer", "Because PDFs are illegal", "To avoid audits"], 0, "Tagging makes ESG data machine-readable.", "medium"],
    ["Board independence is part of which ESG pillar?", ["Governance", "Environmental", "Social", "None"], 0, "How a company is run = Governance.", "medium"],
  ] },
];

function assertLocal() {
  const uri = process.env.MONGO_URI || "";
  const local = /^mongodb(\+srv)?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(uri);
  if (!local && !flag("allow-remote")) {
    console.error("Refusing: MONGO_URI is not a local database. This script seeds DEMO data for local testing only.");
    process.exit(1);
  }
}

async function seed(path) {
  const mods = await Module.find({ _id: { $in: path.moduleIds } }, "title").lean();
  const byId = new Map(mods.map((m) => [String(m._id), m]));
  let added = 0;
  for (const mid of path.moduleIds) {
    const mod = byId.get(String(mid));
    if (!mod) continue;
    const set = BANK.find((b) => b.match.test(mod.title));
    if (!set) { console.log(`   ! no demo questions written for "${mod.title}" — skipped`); continue; }
    const existing = await BankQuestion.countDocuments({ moduleId: mid, question: { $regex: "^\\[Demo\\] " } });
    if (existing) { console.log(`   = "${mod.title}" already has ${existing} demo questions`); continue; }
    if (APPLY) {
      await BankQuestion.insertMany(set.qs.map(([question, options, correctIndex, explanation, difficulty]) => ({
        moduleId: mid, question: DEMO + question, options, correctIndex, explanation, difficulty, status: "active", source: "manual",
      })));
    }
    added += set.qs.length;
    console.log(`   + "${mod.title}": ${set.qs.length} questions`);
  }
  if (!APPLY) return;
  const generated = await forms.generateForm(path._id, { perModule: 2 });
  if (generated.problems?.length) { console.log(`   ! not locked: ${generated.problems[0]}`); return; }
  await forms.lockForm(path._id, null);
  await Path.updateOne({ _id: path._id }, { $set: { "assessment.enabled": true } });
  console.log(`   ✓ Pre/Post generated, locked and switched on (${added} new questions)`);
}

async function remove() {
  const demo = await BankQuestion.find({ question: { $regex: "^\\[Demo\\] " } }, "_id moduleId").lean();
  const ids = demo.map((q) => q._id);
  const touched = await AssessmentForm.find({ $or: [{ "pre.questionId": { $in: ids } }, { "post.questionId": { $in: ids } }] }, "pathId").lean();
  const pathIds = [...new Set(touched.map((f) => String(f.pathId)))];
  console.log(`Demo questions: ${ids.length}; paths with demo tests: ${pathIds.length}`);
  if (!APPLY && !flag("delete")) return;
  for (const pid of pathIds) {
    const attempts = await AssessmentAttempt.deleteMany({ pathId: pid });
    const f = await AssessmentForm.deleteMany({ pathId: pid });
    await Path.updateOne({ _id: pid }, { $set: { "assessment.enabled": false } });
    console.log(`   - path ${pid}: removed ${f.deletedCount} test version(s), ${attempts.deletedCount} attempt(s); Pre/Post switched off`);
  }
  const q = await BankQuestion.deleteMany({ _id: { $in: ids } });
  console.log(`   - removed ${q.deletedCount} demo questions`);
}

(async () => {
  assertLocal();
  await mongoose.connect(process.env.MONGO_URI, { serverApi: { version: "1", strict: true, deprecationErrors: true } });
  try {
    if (DELETE) { await remove(); return; }
    console.log(APPLY ? "Seeding demo Pre/Post…" : "Dry run (add --apply to write):");
    for (const name of PATH_NAMES) {
      const path = await Path.findOne({ name, status: "published" });
      if (!path) { console.log(`Path "${name}" not found (published) — skipped`); continue; }
      console.log(`Path "${path.name}" (${path.moduleIds.length} modules)`);
      await seed(path);
    }
  } finally {
    await mongoose.disconnect();
  }
})().catch((err) => { console.error(err); process.exit(1); });
