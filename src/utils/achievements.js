// src/utils/achievements.js
// Badge definitions + evaluation, and the fixed "Your Orbit" XP-tier scale.
// Badges are evaluated lazily (on read, via checkAndAwardBadges) rather than
// hooked into every XP/streak/idea call site — once earned, a badge is
// permanently persisted on the User doc (src/models/User.js's `badges`
// array), so it stays shown even if the underlying stat later regresses
// (e.g. a streak resetting to 0 after a "Streak x5" badge was earned).
const User = require("../models/User");
const Idea = require("../models/Idea");
const { getProgressStats, getSandboxResultsForUser } = require("../controllers/progressController");

const QUIZ_QUESTION_POINTS = 5;

const BADGE_DEFS = [
  { key: "first_launch", label: "First Launch", check: () => true },
  { key: "streak_5", label: "Streak x5", check: (ctx) => (ctx.user.longestStreak || 0) >= 5 },
  { key: "idea_spark", label: "Idea Spark", check: (ctx) => ctx.ideaCount >= 1 },
  { key: "module_master", label: "Module Master", check: (ctx) => ctx.progressStats.completedModulesCount >= 5 },
  { key: "top_10", label: "Top 10", check: (ctx) => ctx.myRank !== null && ctx.myRank <= 10 },
  {
    key: "sharp_shooter",
    label: "Sharp Shooter",
    check: (ctx) => ctx.mcqAttempted >= 5 && (ctx.mcqCorrectPoints / ctx.mcqMaxPoints) >= 0.9,
  },
];

// Same tier scale for every user — plain XP thresholds, not a persisted
// per-user field, since xp itself is already the persisted source of truth.
const ORBIT_TIERS = [
  { key: "practitioner", label: "Orbit 3 · Practitioner", order: 3, minXP: 0,     maxXP: 3333 },
  { key: "strategist",   label: "Orbit 2 · Strategist",   order: 2, minXP: 3334, maxXP: 9999 },
  { key: "architect",    label: "Orbit 1 · Architect",    order: 1, minXP: 10000, maxXP: null },
];

function getOrbitTier(xp) {
  const safeXp = xp || 0;
  const currentIndex = ORBIT_TIERS.findIndex(t => safeXp >= t.minXP && (t.maxXP === null || safeXp <= t.maxXP));
  const current = ORBIT_TIERS[currentIndex === -1 ? 0 : currentIndex];
  const xpForNextTier = current.maxXP === null ? null : (current.maxXP + 1 - current.minXP);
  const xpIntoTier = safeXp - current.minXP;
  return {
    tiers: ORBIT_TIERS.map((t, i) => ({ ...t, status: i === currentIndex ? "current" : i < currentIndex ? "cleared" : "locked" })),
    current: current.key,
    xpIntoTier,
    xpForNextTier,
  };
}

async function getMyDepartmentRank(user) {
  if (!user.department) return null;
  const higherCount = await User.countDocuments({
    department: user.department,
    isVerified: true,
    xp: { $gt: user.xp || 0 },
  });
  return higherCount + 1;
}

async function checkAndAwardBadges(userId) {
  const user = await User.findById(userId);
  if (!user) return [];

  const [progressStats, ideaCount, sandboxResults, myRank] = await Promise.all([
    getProgressStats(userId),
    Idea.countDocuments({ userId }),
    getSandboxResultsForUser(userId),
    getMyDepartmentRank(user),
  ]);

  let mcqCorrectPoints = 0;
  let mcqMaxPoints = 0;
  let mcqAttempted = 0;
  sandboxResults.forEach((card) => {
    (card.questions || []).forEach((q) => {
      if (q.type === "mcq" || q.type === "true_false") {
        mcqAttempted += 1;
        mcqMaxPoints += QUIZ_QUESTION_POINTS;
        if (q.isCorrect) mcqCorrectPoints += QUIZ_QUESTION_POINTS;
      }
    });
  });

  const ctx = { user, progressStats, ideaCount, myRank, mcqCorrectPoints, mcqMaxPoints, mcqAttempted };

  const earnedKeys = new Set((user.badges || []).map(b => b.key));
  let changed = false;
  BADGE_DEFS.forEach((def) => {
    if (!earnedKeys.has(def.key) && def.check(ctx)) {
      user.badges.push({ key: def.key, earnedAt: new Date() });
      earnedKeys.add(def.key);
      changed = true;
    }
  });
  if (changed) await user.save();

  const earnedMap = {};
  (user.badges || []).forEach(b => { earnedMap[b.key] = b.earnedAt; });

  return BADGE_DEFS.map(def => ({
    key: def.key,
    label: def.label,
    unlocked: earnedMap[def.key] !== undefined,
    earnedAt: earnedMap[def.key] || null,
  }));
}

function getLast7Days(user) {
  const history = {};
  (user.engagementHistory || []).forEach(e => { history[e.date] = e.qualifiesForStreak; });

  const days = [];
  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateKey = d.toISOString().slice(0, 10);
    days.push({ date: dateKey, active: Boolean(history[dateKey]) });
  }
  return days;
}

module.exports = { checkAndAwardBadges, getOrbitTier, getLast7Days, getMyDepartmentRank, BADGE_DEFS, ORBIT_TIERS };
