// migrateCouncilTeams.js
// One-time backfill for the Council-team feature (see Team.js's `isCouncil`
// flag and departmentRoutes.js's POST /api/departments, which now auto-
// creates a Council team for every NEW department). Departments created
// before this feature landed don't have one yet, and any admin who was
// previously "department-wide" via a null `team` field needs to be
// re-pointed at their department's Council team so `team` is never null
// for an admin again.
//
// Idempotent — safe to re-run. Does nothing to departments that already
// have a Council team, or admins who already have a team assigned.
//
// USAGE
//
//   node migrateCouncilTeams.js
//
require("dotenv").config();
const mongoose = require("mongoose");

const Department = require("./src/models/Department");
const Team = require("./src/models/Team");
const User = require("./src/models/User");

async function ensureCouncilTeams() {
  const departments = await Department.find({});
  const councilByDept = new Map();

  for (const dept of departments) {
    let council = await Team.findOne({ department_id: dept._id, isCouncil: true });
    if (!council) {
      council = await Team.create({
        name: "Council",
        code: "COUNCIL",
        department_id: dept._id,
        isCouncil: true,
      });
      console.log(`Created Council team for department "${dept.name}" (${dept._id})`);
    }
    councilByDept.set(dept._id.toString(), council);
  }

  return councilByDept;
}

async function backfillTeamlessAdmins(councilByDept) {
  const teamlessAdmins = await User.find({ role: "admin", team: null });
  console.log(`\nFound ${teamlessAdmins.length} admin(s) with no team assigned.`);

  for (const admin of teamlessAdmins) {
    if (!admin.department) {
      console.warn(`  Skipping ${admin.username} (${admin._id}) — no department set either, can't resolve a Council team.`);
      continue;
    }
    const council = councilByDept.get(admin.department.toString());
    if (!council) {
      console.warn(`  Skipping ${admin.username} (${admin._id}) — department ${admin.department} not found.`);
      continue;
    }
    admin.team = council._id;
    await admin.save();
    console.log(`  ${admin.username} -> Council team of their department`);
  }
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI || process.env.DATABASE_URL);
  console.log("Connected to MongoDB.\n");

  const councilByDept = await ensureCouncilTeams();
  await backfillTeamlessAdmins(councilByDept);

  console.log("\nDone.");
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Migration script failed:", err);
  process.exit(1);
});
