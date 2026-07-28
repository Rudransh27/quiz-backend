// seedDemoData.js
// Fills the real dev database with a rich, varied dataset spanning every
// department/team/role/feature — so a human can manually click through and
// exercise admin/superadmin/user functionality end to end. NOT a throwaway
// test fixture: this is meant to persist. Safe-ish to re-run (uses
// find-or-create for departments/teams; will error on duplicate emails if
// run twice without clearing the `demo.*@irisregtech.com` users first).
//
// USAGE
//   node seedDemoData.js
//
require("dotenv").config();
const mongoose = require("mongoose");

const Department = require("./src/models/Department");
const Team = require("./src/models/Team");
const User = require("./src/models/User");
const Module = require("./src/models/Module");
const Topic = require("./src/models/Topic");
const Card = require("./src/models/Card");
const DailyRead = require("./src/models/DailyRead");
const News = require("./src/models/News");
const Idea = require("./src/models/Idea");
const UserCardProgress = require("./src/models/UserCardProgress");
const UserTopicProgress = require("./src/models/UserTopicProgress");
const UserModuleProgress = require("./src/models/UserModuleProgress");
const TeamTransferRequest = require("./src/models/TeamTransferRequest");

// ── small deterministic-ish randomness helpers (this is a normal Node
// script, not a Workflow — Math.random()/Date are fine here) ───────────────
const FIRST_NAMES = ["Aisha", "Rohan", "Meera", "Kabir", "Zara", "Vikram", "Ananya", "Dev", "Priya", "Arjun", "Sana", "Nikhil", "Ishita", "Farhan", "Tara", "Yusuf", "Divya", "Aditya", "Neha", "Sameer"];
const LAST_NAMES = ["Sharma", "Khan", "Iyer", "Reddy", "Patel", "Nair", "Gupta", "Bose", "Chatterjee", "Verma", "Mehta", "Rao", "Kapoor", "Joshi", "Singh"];
const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
let emailCounter = 0;
function makePerson() {
  const first = rand(FIRST_NAMES);
  const last = rand(LAST_NAMES);
  emailCounter += 1;
  const username = `demo_${first}${last}${emailCounter}`.toLowerCase();
  const email = `demo.${first.toLowerCase()}.${last.toLowerCase()}${emailCounter}@irisregtech.com`;
  return { username, email, displayName: `${first} ${last}` };
}

const TEAM_TEMPLATES = [
  ["Sales", "SALES"],
  ["Engineering", "ENG"],
  ["Support", "SUPPORT"],
];

async function ensureTeam(departmentId, name, code) {
  let team = await Team.findOne({ department_id: departmentId, code });
  if (!team) team = await Team.create({ name, code, department_id: departmentId });
  return team;
}

async function ensureUser({ role, department, team, xp, verified = true }) {
  const p = makePerson();
  return User.create({
    username: p.username,
    email: p.email,
    password: "Demo@1234",
    role,
    department,
    team,
    isVerified: verified,
    avatarId: rand(["dev", "xbrl", "db", "cyber"]),
    xp,
  });
}

function todayKey(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().split("T")[0];
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected to MongoDB.\n");

  const departments = await Department.find({});
  const credentials = [];

  // ============================================================
  // 1. Teams, admins, and members for every department
  // ============================================================
  const deptContext = [];
  for (const dept of departments) {
    const nonCouncilTeams = await Team.find({ department_id: dept._id, isCouncil: false });
    const teams = [...nonCouncilTeams];
    for (const [name, code] of TEAM_TEMPLATES) {
      if (teams.some((t) => t.code === code)) continue;
      if (teams.length >= 3) break;
      teams.push(await ensureTeam(dept._id, name, code));
    }
    const council = await Team.findOne({ department_id: dept._id, isCouncil: true });

    const teamMembers = []; // { team, members: [user] }
    for (const team of teams) {
      const existingAdmin = await User.findOne({ team: team._id, role: "admin" });
      let admin = existingAdmin;
      if (!admin) {
        admin = await ensureUser({ role: "admin", department: dept._id, team: team._id, xp: randInt(300, 1200) });
        credentials.push(`${dept.code}/${team.code} admin  -> ${admin.email} / Demo@1234`);
      }
      const memberCount = randInt(5, 7);
      const members = [];
      for (let i = 0; i < memberCount; i++) {
        const user = await ensureUser({ role: "user", department: dept._id, team: team._id, xp: randInt(0, 3200) });
        // Sprinkle some daily-read engagement history over the last 7 days.
        const activeDays = randInt(0, 5);
        const history = [];
        for (let d = 0; d < activeDays; d++) {
          const date = todayKey(-d);
          const actions = [];
          if (Math.random() > 0.4) actions.push("daily_read");
          if (Math.random() > 0.6) actions.push("module_progress");
          if (Math.random() > 0.85) actions.push("idea_submission");
          if (actions.length) history.push({ date, qualifiesForStreak: true, actions });
        }
        if (history.length) {
          user.engagementHistory = history;
          user.currentStreak = history.length;
          user.longestStreak = Math.max(history.length, randInt(0, 8));
          user.lastActiveDate = history[0]?.date || null;
          await user.save();
        }
        members.push(user);
      }
      teamMembers.push({ team, admin, members });
    }

    // A Council admin too, if none exists yet (department-wide access).
    let councilAdmin = await User.findOne({ team: council._id, role: "admin" });
    if (!councilAdmin) {
      councilAdmin = await ensureUser({ role: "admin", department: dept._id, team: council._id, xp: randInt(500, 1500) });
      credentials.push(`${dept.code}/COUNCIL admin -> ${councilAdmin.email} / Demo@1234`);
    }

    deptContext.push({ dept, teams, teamMembers, council, councilAdmin });
  }

  console.log(`Seeded/verified teams, admins, and ~${deptContext.reduce((s, d) => s + d.teamMembers.reduce((s2, tm) => s2 + tm.members.length, 0), 0)} members across ${departments.length} departments.\n`);

  // ============================================================
  // 2. Modules — one Global, one Departmental (STANDARD, topics+mixed
  //    cards) and one Team-Specific EXPRESS_FLAT per department.
  // ============================================================
  const allModules = [];

  const globalModule = await Module.findOne({ title: "Demo: Cross-Department Compliance Basics" }) || await Module.create({
    title: "Demo: Cross-Department Compliance Basics",
    description: "A short, always-visible refresher every team can take regardless of department.",
    visibility: "Global",
    hasTopics: false,
    engineStrategy: "EXPRESS_FLAT",
    moduleType: "standard",
    estimatedTime: 10,
  });
  allModules.push(globalModule);
  if ((await Card.countDocuments({ module_id: globalModule._id })) === 0) {
    await Card.insertMany([
      { module_id: globalModule._id, cardOrder: 0, card_type: "knowledge", content: { title: "Why Compliance Matters", text: "XBRL tagging accuracy directly affects regulator trust. This module covers the basics every team should know." } },
      { module_id: globalModule._id, cardOrder: 1, card_type: "quiz", content: { title: "Quick Check", question: "What does XBRL stand for?", options: ["eXtensible Business Reporting Language", "Extended Binary Report Layer", "eXtra Business Report Log", "eXecutable Business Rule Language"], correctIndex: 0, explanation: "XBRL = eXtensible Business Reporting Language, the global standard for exchanging business information." } },
    ]);
  }

  for (const { dept, teams } of deptContext) {
    // Departmental STANDARD module with 2 topics, mixed card types.
    const deptModuleTitle = `${dept.name}: Departmental Onboarding`;
    let deptModule = await Module.findOne({ title: deptModuleTitle });
    if (!deptModule) {
      deptModule = await Module.create({
        title: deptModuleTitle,
        description: `Onboarding curriculum specific to ${dept.name}.`,
        visibility: "Departmental",
        departments: [dept._id],
        hasTopics: true,
        engineStrategy: "STANDARD",
        moduleType: "standard",
        estimatedTime: 20,
      });
      const topic1 = await Topic.create({ module_id: deptModule._id, title: "Fundamentals", topicOrder: 0, estimatedTime: 10 });
      const topic2 = await Topic.create({ module_id: deptModule._id, title: "Applied Practice", topicOrder: 1, estimatedTime: 10 });
      await Card.insertMany([
        { topic_id: topic1._id, cardOrder: 0, card_type: "knowledge", content: { title: `Welcome to ${dept.name}`, text: `This module walks through what makes ${dept.name} tick day to day.` } },
        { topic_id: topic1._id, cardOrder: 1, card_type: "quiz", content: { title: "Check your understanding", question: `Which department is this module for?`, options: [dept.name, "None of the above", "Every department", "Unknown"], correctIndex: 0, explanation: `This module is specific to ${dept.name}.` } },
        { topic_id: topic2._id, cardOrder: 0, card_type: "code", content: { title: "Tagging Practice", question: "Which validator checks a unitRef mapping?", validator: "validateUnitRefAnswer", hint: "Think about what a unitRef ties together." } },
        { topic_id: topic2._id, cardOrder: 1, card_type: "video", content: { title: "Walkthrough", videoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", description: "A short walkthrough video." } },
      ]);
    }
    allModules.push(deptModule);

    // Team-specific EXPRESS_FLAT module for the first non-council team.
    if (teams.length > 0) {
      const targetTeam = teams[0];
      const teamModuleTitle = `${dept.name}/${targetTeam.name}: Sandbox Drill`;
      let teamModule = await Module.findOne({ title: teamModuleTitle });
      if (!teamModule) {
        teamModule = await Module.create({
          title: teamModuleTitle,
          description: `Team-specific hands-on drill for ${targetTeam.name}.`,
          visibility: "Team-Specific",
          departments: [dept._id],
          targetTeams: [targetTeam._id],
          hasTopics: false,
          engineStrategy: "EXPRESS_FLAT",
          moduleType: "standard",
          estimatedTime: 8,
        });
        await Card.insertMany([
          { module_id: teamModule._id, cardOrder: 0, card_type: "knowledge", content: { title: "Team Drill Intro", text: `Only ${targetTeam.name} sees this module.` } },
          { module_id: teamModule._id, cardOrder: 1, card_type: "quiz", content: { title: "Drill Check", question: "Is this module visible to other teams?", options: ["Yes", "No"], correctIndex: 1, explanation: "Team-Specific modules are only visible to their targetTeams." } },
        ]);
      }
      allModules.push(teamModule);
    }
  }
  console.log(`Seeded ${allModules.length} modules (Global / Departmental / Team-Specific mix).\n`);

  // ============================================================
  // 3. Progress data — random subset of members get real card/topic/module
  //    progress so analytics/leaderboards/completion bars show real numbers.
  // ============================================================
  let progressCount = 0;
  for (const { teamMembers } of deptContext) {
    for (const { members } of teamMembers) {
      for (const member of members) {
        if (Math.random() > 0.6) continue; // not everyone has touched a module
        const targetModule = rand(allModules);
        const cards = await Card.find({ $or: [{ module_id: targetModule._id }, { topic_id: { $in: (await Topic.find({ module_id: targetModule._id })).map((t) => t._id) } }] });
        for (const card of cards) {
          const isQuiz = card.card_type === "quiz";
          const isCorrect = isQuiz ? Math.random() > 0.35 : true;
          await UserCardProgress.create({
            user_id: member._id,
            card_id: card._id,
            module_id: targetModule._id,
            topic_id: card.topic_id || undefined,
            isCorrect,
            score: isQuiz ? (isCorrect ? 5 : 0) : 2,
            maxScore: isQuiz ? 5 : 2,
            xpAwarded: isQuiz ? (isCorrect ? 5 : 0) : 2,
          }).catch(() => {}); // ignore dup key if re-run
          progressCount += 1;
        }
        if (targetModule.hasTopics) {
          const topics = await Topic.find({ module_id: targetModule._id });
          for (const topic of topics) {
            if (Math.random() > 0.5) {
              await UserTopicProgress.create({ user_id: member._id, topic_id: topic._id, module_id: targetModule._id, isCompleted: true, pointsAwarded: true, bestXP: randInt(5, 20) }).catch(() => {});
            }
          }
        } else if (Math.random() > 0.5) {
          await UserModuleProgress.create({ user_id: member._id, module_id: targetModule._id, isCompleted: true, pointsAwarded: true, bestXP: randInt(5, 20) }).catch(() => {});
        }
      }
    }
  }
  console.log(`Seeded ~${progressCount} card-progress records.\n`);

  // ============================================================
  // 4. Daily reads — one for today per department.
  // ============================================================
  for (const { dept, councilAdmin } of deptContext) {
    const dateKey = todayKey(0);
    const exists = await DailyRead.findOne({ department: dept._id, dateKey });
    if (!exists) {
      await DailyRead.create({
        title: `${dept.name} Daily Read — Staying Sharp`,
        content: `A quick daily read for everyone in ${dept.name}. Consistency beats intensity — keep the streak alive!`,
        tags: ["daily", dept.code],
        postedBy: councilAdmin._id,
        dateKey,
        department: dept._id,
      });
    }
  }
  console.log("Seeded today's Daily Read for each department.\n");

  // ============================================================
  // 5. News — 2 Global + 6 Departmental for the first department (to
  //    demo the 5-item learner-feed cap), 2-3 for the rest.
  // ============================================================
  const anyAdmin = deptContext[0].councilAdmin;
  const existingGlobalNews = await News.countDocuments({ scope: "Global" });
  if (existingGlobalNews < 2) {
    await News.insertMany([
      { title: "Platform-wide: New Sandbox Labs live", content: "Try the new interactive sandbox labs across all departments.", scope: "Global", isBreaking: true, createdBy: anyAdmin._id },
      { title: "Reminder: Quarterly review coming up", content: "Make sure your module progress is up to date before the quarterly review.", scope: "Global", createdBy: anyAdmin._id },
    ]);
  }
  for (let i = 0; i < deptContext.length; i++) {
    const { dept, councilAdmin } = deptContext[i];
    const count = i === 0 ? 6 : randInt(2, 3);
    const existing = await News.countDocuments({ scope: "Departmental", department: dept._id });
    if (existing >= count) continue;
    const toCreate = [];
    for (let n = existing; n < count; n++) {
      toCreate.push({
        title: `${dept.name} Update #${n + 1}`,
        content: `Departmental news item #${n + 1} for ${dept.name}.`,
        scope: "Departmental",
        department: dept._id,
        isBreaking: n === count - 1,
        createdBy: councilAdmin._id,
        createdAt: new Date(Date.now() - (count - n) * 60000),
      });
    }
    if (toCreate.length) await News.insertMany(toCreate);
  }
  console.log("Seeded News (Global + Departmental, first department has 6 to demo the 5-item cap).\n");

  // ============================================================
  // 6. Ideas — 3-5 per department, varied statuses.
  // ============================================================
  const STATUSES = ["submitted", "in review", "building", "shipped", "parked", "rejected"];
  const TAGS = ["product", "process", "technology", "culture"];
  let ideaCount = 0;
  for (const { dept, teamMembers } of deptContext) {
    const allMembers = teamMembers.flatMap((tm) => tm.members);
    const count = randInt(3, 5);
    for (let i = 0; i < count; i++) {
      const author = rand(allMembers.length ? allMembers : [deptContext[0].councilAdmin]);
      const status = rand(STATUSES);
      await Idea.create({
        title: `Idea #${i + 1} from ${dept.name}: streamline our workflow`,
        details: "A longer explanation of what this idea would change and why it matters for the team.",
        userName: author.username,
        userEmail: author.email,
        tag: rand(TAGS),
        status,
        curatorFeedback: status === "shipped" || status === "rejected" ? "Reviewed by the Product Council." : "",
        xpAwarded: status === "building" || status === "shipped",
        userId: author._id,
        departmentId: dept._id,
      });
      ideaCount += 1;
    }
  }
  console.log(`Seeded ${ideaCount} ideas across departments.\n`);

  // ============================================================
  // 7. One pending team-transfer request, for Team Hub demo purposes.
  // ============================================================
  const demoDept = deptContext.find((d) => d.teamMembers.length >= 2);
  if (demoDept) {
    const [sourceTm, targetTm] = demoDept.teamMembers;
    const memberToMove = sourceTm.members[0];
    if (memberToMove && targetTm.admin) {
      const already = await TeamTransferRequest.findOne({ user: memberToMove._id, status: "pending" });
      if (!already) {
        await TeamTransferRequest.create({
          user: memberToMove._id,
          fromTeam: sourceTm.team._id,
          toTeam: targetTm.team._id,
          department: demoDept.dept._id,
          requestedBy: sourceTm.admin._id,
          status: "pending",
        });
        console.log(`Seeded one pending team-transfer request in ${demoDept.dept.name} (${sourceTm.team.name} -> ${targetTm.team.name}) for Team Hub demo.\n`);
      }
    }
  }

  // ============================================================
  // Summary
  // ============================================================
  console.log("=".repeat(70));
  console.log("DEMO DATA SEEDED. Sample login credentials (password: Demo@1234):");
  console.log("=".repeat(70));
  credentials.slice(0, 12).forEach((c) => console.log("  " + c));
  console.log(`  ...and ${Math.max(0, credentials.length - 12)} more admin accounts (all password Demo@1234).`);
  console.log("\nYour existing superadmin account is unchanged — log in with that to see everything.");

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Seed script failed:", err);
  process.exit(1);
});
