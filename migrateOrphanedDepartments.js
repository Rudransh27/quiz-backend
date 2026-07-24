// migrateOrphanedDepartments.js
// One-time repair for content/users whose `department` (or, for Idea,
// `departmentId`) ObjectId no longer matches any existing Department
// document. This happens when seedDepartments.js's old delete-then-reinsert
// behavior handed every department a brand-new _id on a re-run — anything
// that already referenced the old _id (a Module, a Daily Read, a News post,
// a User, an Idea) was silently orphaned. See seedDepartments.js for the
// upsert-based fix that stops this from happening again; this script only
// repairs data that was already orphaned before that fix landed.
//
// It never guesses which department an orphaned reference used to belong
// to — that information no longer exists anywhere once the old Department
// doc is deleted. You must tell it explicitly via --map.
//
// USAGE
//
//   Dry run (default, no writes) — lists every stale department _id found,
//   how many records in each collection carry it, and the current real
//   departments to map them onto:
//
//     node migrateOrphanedDepartments.js
//
//   Apply — re-points every record carrying a given stale _id to the
//   CURRENT _id of a named department (matched by Department.code):
//
//     node migrateOrphanedDepartments.js --apply --map=<staleId>=<code>[,<staleId2>=<code2>,...]
//
//   Example — one stale id, all pointed at the real "carbon" department:
//
//     node migrateOrphanedDepartments.js --apply --map=64f1a2b3c4d5e6f7a8b9c0d1=carbon
//
require("dotenv").config();
const mongoose = require("mongoose");

const Department = require("./src/models/Department");
const Module = require("./src/models/Module");
const DailyRead = require("./src/models/DailyRead");
const News = require("./src/models/News");
const User = require("./src/models/User");
const Idea = require("./src/models/Idea");

// field name differs on Idea ("departmentId") vs everything else
// ("department") — kept explicit here rather than assumed uniform.
const TARGETS = [
  { label: "Module", model: Module, field: "department" },
  { label: "DailyRead", model: DailyRead, field: "department" },
  { label: "News", model: News, field: "department" },
  { label: "User", model: User, field: "department" },
  { label: "Idea", model: Idea, field: "departmentId" },
];

function parseArgs() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const mapToken = argv.find((a) => a.startsWith("--map="));
  const mapping = {}; // staleIdString -> departmentCode
  if (mapToken) {
    const raw = mapToken.slice("--map=".length);
    raw.split(",").filter(Boolean).forEach((pair) => {
      const [staleId, code] = pair.split("=");
      if (staleId && code) mapping[staleId.trim()] = code.trim().toLowerCase();
    });
  }
  return { apply, mapping };
}

async function findOrphans() {
  const departments = await Department.find({});
  const validIds = new Set(departments.map((d) => d._id.toString()));

  // staleId -> { label: count, ... }
  const orphans = {};

  for (const { label, model, field } of TARGETS) {
    const distinctIds = await model.distinct(field, { [field]: { $ne: null } });
    for (const id of distinctIds) {
      const idStr = id.toString();
      if (validIds.has(idStr)) continue;
      const count = await model.countDocuments({ [field]: id });
      orphans[idStr] = orphans[idStr] || {};
      orphans[idStr][label] = count;
    }
  }

  return { departments, orphans };
}

async function report() {
  const { departments, orphans } = await findOrphans();

  console.log("=== Current departments (map orphaned records onto one of these codes) ===");
  departments.forEach((d) => console.log(`  ${d._id}  code="${d.code}"  name="${d.name}"`));

  const staleIds = Object.keys(orphans);
  if (staleIds.length === 0) {
    console.log("\nNo orphaned department references found. Nothing to repair.");
    return;
  }

  console.log("\n=== Orphaned department _ids found ===");
  staleIds.forEach((staleId) => {
    console.log(`\n  Stale _id: ${staleId}`);
    Object.entries(orphans[staleId]).forEach(([label, count]) => {
      console.log(`    ${label.padEnd(10)}: ${count}`);
    });
  });

  console.log(
    "\nRe-run with:\n" +
    `  node migrateOrphanedDepartments.js --apply --map=${staleIds
      .map((id) => `${id}=<code>`)
      .join(",")}\n` +
    "replacing each <code> with one of the department codes listed above."
  );
}

async function apply(mapping) {
  if (Object.keys(mapping).length === 0) {
    console.error("--apply requires --map=<staleId>=<code>[,...]. Run without --apply first to see stale ids.");
    process.exitCode = 1;
    return;
  }

  const { orphans } = await findOrphans();
  const departments = await Department.find({});
  const byCode = new Map(departments.map((d) => [d.code, d]));

  for (const [staleId, code] of Object.entries(mapping)) {
    const targetDept = byCode.get(code);
    if (!targetDept) {
      console.error(`Skipping ${staleId} -> "${code}": no department with that code exists. Valid codes: ${departments.map((d) => d.code).join(", ")}`);
      continue;
    }
    if (!orphans[staleId]) {
      console.warn(`Skipping ${staleId} -> "${code}": no orphaned records reference this _id anywhere — check you copied it correctly.`);
      continue;
    }

    console.log(`\nRe-pointing ${staleId} -> ${targetDept.code} (${targetDept._id}):`);
    const staleObjectId = new mongoose.Types.ObjectId(staleId);

    for (const { label, model, field } of TARGETS) {
      const result = await model.updateMany(
        { [field]: staleObjectId },
        { $set: { [field]: targetDept._id } }
      );
      if (result.modifiedCount > 0) {
        console.log(`  ${label.padEnd(10)}: ${result.modifiedCount} updated`);
      }
    }
  }
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI || process.env.DATABASE_URL);
  console.log("Connected to MongoDB.\n");

  const { apply: shouldApply, mapping } = parseArgs();
  if (shouldApply) {
    await apply(mapping);
  } else {
    await report();
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Migration script failed:", err);
  process.exit(1);
});
