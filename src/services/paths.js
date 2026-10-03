// src/services/paths.js
//
// Everything that decides what a learner sees and can open once Paths exist:
//   • which Paths are visible to them (published + audience + ≥1 visible module)
//   • per Path: the visible module chain, completion, sequential unlock, and
//     the Pre/Post assessment gates
//   • whether a given module is unlocked for them (used by the lock check that
//     every content-serving and grading route goes through)
//
// "Path mode" switches on as soon as at least one Path is published. Before
// that (e.g. code deployed but migration not yet run) the legacy per-Tag
// lock in utils/moduleLock.js keeps working unchanged.
const mongoose = require("mongoose");
const Path = require("../models/Path");
const Module = require("../models/Module");
const UserCardProgress = require("../models/UserCardProgress");
const AssessmentAttempt = require("../models/AssessmentAttempt");
const { computeModuleCompletionMap } = require("../utils/moduleLock");
const { assertModuleViewAccess } = require("../utils/moduleAccess");
const { toIdArray } = require("../utils/scopeHelpers");

const MODULE_FIELDS = "title description imageUrl hasTopics engineStrategy estimatedTime visibility departments targetTeams regions categoryId isHotModule isPopular moduleType order";

const ctxOf = (req) => (req.user && req.user.user ? req.user.user : req.user);
const userIdOf = (req) => { const u = ctxOf(req); return u ? (u.id || u._id) : null; };
const isPrivileged = (req) => req.user.role === "admin" || req.user.role === "superadmin";
const idStr = (v) => (v && v._id ? v._id : v).toString();

// Each non-empty audience list must match the learner; empty = everyone.
// A learner with no regions on their profile matches every region (same
// rule as passesRegionScope for modules and tags).
function audienceMatches(path, req) {
  if (req.user.role === "superadmin") return true;
  const u = ctxOf(req);
  const a = path.audience || {};
  const regions = toIdArray(a.regions);
  if (regions.length) {
    const mine = toIdArray(u.regions);
    if (mine.length && !mine.some((r) => regions.includes(r))) return false;
  }
  const depts = toIdArray(a.departments);
  if (depts.length && !(u.department && depts.includes(idStr(u.department)))) return false;
  const teams = toIdArray(a.teams);
  if (teams.length && !(u.team && teams.includes(idStr(u.team)))) return false;
  return true;
}

let cachedEnabled = { value: null, at: 0 };
async function pathsEnabled() {
  // Tiny cache: this is asked on every lock check.
  if (cachedEnabled.value !== null && Date.now() - cachedEnabled.at < 5000) return cachedEnabled.value;
  const value = !!(await Path.exists({ status: "published" }));
  cachedEnabled = { value, at: Date.now() };
  return value;
}
function invalidatePathsEnabled() { cachedEnabled = { value: null, at: 0 }; }

// Prefix walk in the Path's own order: the first module is open; each next
// one opens once every module before it is complete.
function walkPath(moduleList, completionMap) {
  const unlocked = new Set();
  for (const m of moduleList) {
    const id = m._id.toString();
    unlocked.add(id);
    if (!completionMap.get(id)) break;
  }
  return unlocked;
}

// Per-learner state for a set of Paths, computed with a fixed number of
// queries regardless of how many Paths/modules are involved.
async function computePathStates(req, paths) {
  if (!paths.length) return [];
  const userId = userIdOf(req);
  const privileged = isPrivileged(req);

  const allIds = [...new Set(paths.flatMap((p) => (p.moduleIds || []).map(idStr)))];
  const modules = allIds.length
    ? await Module.find({ _id: { $in: allIds } }, MODULE_FIELDS).lean()
    : [];
  const moduleMap = new Map(modules.map((m) => [m._id.toString(), m]));
  const visibleModules = modules.filter((m) => assertModuleViewAccess(m, req).ok);
  const visibleSet = new Set(visibleModules.map((m) => m._id.toString()));

  const pathIds = paths.map((p) => p._id);
  const [completionMap, attempts, touched] = await Promise.all([
    computeModuleCompletionMap({ modules: visibleModules, userId }),
    AssessmentAttempt.find({ user_id: userId, pathId: { $in: pathIds } }, "pathId kind percent score maxScore createdAt").lean(),
    // aggregate, not distinct: the server connects with the Stable API in
    // strict mode (config/db.js), where `distinct` is not allowed.
    allIds.length
      ? UserCardProgress.aggregate([
        { $match: { user_id: new mongoose.Types.ObjectId(String(userId)), isArchived: { $ne: true }, module_id: { $in: allIds.map((i) => new mongoose.Types.ObjectId(i)) } } },
        { $group: { _id: "$module_id" } },
      ])
      : [],
  ]);
  const touchedSet = new Set(touched.map((t) => idStr(t._id)));
  const attemptBy = new Map(attempts.map((a) => [`${a.pathId}:${a.kind}`, a]));

  return paths.map((path) => {
    const mods = (path.moduleIds || []).map(idStr).filter((id) => visibleSet.has(id)).map((id) => moduleMap.get(id));
    const pre = attemptBy.get(`${path._id}:pre`) || null;
    const post = attemptBy.get(`${path._id}:post`) || null;
    const assessmentOn = !!path.assessment?.enabled;
    // Learners who already had progress in this Path's modules when its
    // assessment started (e.g. before launch) skip Pre: "no baseline".
    const noBaseline = assessmentOn && !pre && mods.some((m) => touchedSet.has(m._id.toString()));
    const preRequired = assessmentOn && !pre && !noBaseline;

    let unlocked;
    if (privileged || path.sequentialUnlock === false) unlocked = new Set(mods.map((m) => m._id.toString()));
    else unlocked = walkPath(mods, completionMap);
    if (preRequired && !privileged) unlocked = new Set();

    const moduleStates = mods.map((m) => {
      const id = m._id.toString();
      return { module: m, completed: !!completionMap.get(id), unlocked: unlocked.has(id) };
    });
    const completedCount = moduleStates.filter((s) => s.completed).length;
    const allComplete = moduleStates.length > 0 && completedCount === moduleStates.length;

    return {
      path,
      modules: moduleStates,
      completedCount,
      totalCount: moduleStates.length,
      assessment: {
        enabled: assessmentOn,
        preDone: !!pre,
        postDone: !!post,
        prePercent: pre ? pre.percent : null,
        postPercent: post ? post.percent : null,
        noBaseline,
        preRequired,
        postUnlocked: assessmentOn && !post && allComplete,
      },
      allComplete,
    };
  });
}

// Published Paths this learner can see (audience match + ≥1 visible module),
// optionally within one Tag. Returned with their per-learner state.
async function visiblePathStates(req, { categoryId } = {}) {
  const filter = { status: "published" };
  if (categoryId) filter.categoryId = categoryId;
  const paths = (await Path.find(filter).sort({ order: 1, createdAt: 1 }).lean()).filter((p) => audienceMatches(p, req));
  const states = await computePathStates(req, paths);
  return states.filter((s) => s.totalCount > 0);
}

// Is this module unlocked for the learner in at least one visible, published
// Path? A module that sits in no visible Path is not open (hidden, like a draft).
async function isModuleUnlockedInPaths(req, moduleId) {
  if (isPrivileged(req)) return true;
  const paths = (await Path.find({ status: "published", moduleIds: moduleId }).lean()).filter((p) => audienceMatches(p, req));
  if (!paths.length) return false;
  const states = await computePathStates(req, paths);
  const id = moduleId.toString();
  return states.some((s) => s.modules.some((m) => m.module._id.toString() === id && m.unlocked));
}

module.exports = {
  audienceMatches,
  pathsEnabled,
  invalidatePathsEnabled,
  computePathStates,
  visiblePathStates,
  isModuleUnlockedInPaths,
  walkPath,
  MODULE_FIELDS,
};
