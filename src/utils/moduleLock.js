// src/utils/moduleLock.js
// Shared sequential-module-unlock engine — the single place that decides
// "is module X unlocked for user Y" so the rule can never drift between the
// catalog listing (workspace-curriculum), the content-serving route
// (GET /api/modules/:id), and the write/XP-award route (recordCardCompletion).
const mongoose = require("mongoose");
const Module = require("../models/Module");
const Category = require("../models/Category");
const Topic = require("../models/Topic");
const Card = require("../models/Card");
const UserTopicProgress = require("../models/UserTopicProgress");
const UserModuleProgress = require("../models/UserModuleProgress");

const isExpressFlatModule = (mod) =>
  mod.engineStrategy === "EXPRESS_FLAT" || mod.hasTopics === false;

// =========================================================================
// Batched "is this module fully completed by this user" check across an
// arbitrary set of modules (may span many categories) — exactly one query
// per model, never one per module.
//   STANDARD module  = complete iff EVERY Topic under it has a
//                       UserTopicProgress.isCompleted:true doc.
//   EXPRESS_FLAT     = complete iff UserModuleProgress.isCompleted:true.
//   0 topics/cards   = trivially complete (never blocks the chain).
// Returns Map<moduleIdString, boolean>.
// =========================================================================
async function computeModuleCompletionMap({ modules, userId }) {
  const map = new Map();
  if (!modules || modules.length === 0) return map;

  const uid = new mongoose.Types.ObjectId(userId.toString());
  const standardModules = modules.filter((m) => !isExpressFlatModule(m));
  const flatModules = modules.filter(isExpressFlatModule);

  if (standardModules.length) {
    const standardIds = standardModules.map((m) => m._id);

    const [topicTotals, topicDone] = await Promise.all([
      Topic.aggregate([
        { $match: { module_id: { $in: standardIds } } },
        { $group: { _id: "$module_id", total: { $sum: 1 } } },
      ]),
      UserTopicProgress.aggregate([
        { $match: { user_id: uid, module_id: { $in: standardIds }, isCompleted: true } },
        { $group: { _id: "$module_id", done: { $sum: 1 } } },
      ]),
    ]);

    const totalMap = new Map(topicTotals.map((t) => [t._id.toString(), t.total]));
    const doneMap = new Map(topicDone.map((t) => [t._id.toString(), t.done]));

    for (const mod of standardModules) {
      const id = mod._id.toString();
      const total = totalMap.get(id) || 0;
      map.set(id, total === 0 ? true : (doneMap.get(id) || 0) >= total);
    }
  }

  if (flatModules.length) {
    const flatIds = flatModules.map((m) => m._id);

    const [cardTotals, progressDocs] = await Promise.all([
      Card.aggregate([
        { $match: { module_id: { $in: flatIds } } },
        { $group: { _id: "$module_id", total: { $sum: 1 } } },
      ]),
      UserModuleProgress.find(
        { user_id: uid, module_id: { $in: flatIds } },
        "module_id isCompleted"
      ).lean(),
    ]);

    const cardTotalMap = new Map(cardTotals.map((c) => [c._id.toString(), c.total]));
    const completedFlatSet = new Set(
      progressDocs.filter((p) => p.isCompleted).map((p) => p.module_id.toString())
    );

    for (const mod of flatModules) {
      const id = mod._id.toString();
      const totalCards = cardTotalMap.get(id) || 0;
      map.set(id, totalCards === 0 ? true : completedFlatSet.has(id));
    }
  }

  return map;
}

// =========================================================================
// Pure (no DB) sequential walk: given ALL modules of ONE category and a
// precomputed completion map, returns the Set<string> of module _id strings
// unlocked right now. The first module (lowest order) is always unlocked;
// module N+1 unlocks only once module N is `true` in the completion map.
// =========================================================================
function walkSequentialUnlock(categoryModules, completionMap) {
  const sorted = [...categoryModules].sort((a, b) => {
    const oa = Number.isFinite(a.order) ? a.order : 0;
    const ob = Number.isFinite(b.order) ? b.order : 0;
    if (oa !== ob) return oa - ob;
    return a._id.toString().localeCompare(b._id.toString());
  });

  const unlocked = new Set();
  let chainOpen = true;
  for (const mod of sorted) {
    if (!chainOpen) break;
    const id = mod._id.toString();
    unlocked.add(id);
    if (!completionMap.get(id)) chainOpen = false;
  }
  return unlocked;
}

// =========================================================================
// DB-backed convenience: unlocked module ids for ONE category's module list.
//   modules: plain docs for ALL modules in ONE category, each with at least
//            { _id, order, hasTopics, engineStrategy }.
//   sequentialUnlock: the category's own flag — when false, every module in
//            `modules` comes back unlocked with no completion queries at all.
// =========================================================================
async function getUnlockedModuleIds({ modules, userId, sequentialUnlock }) {
  if (!modules || modules.length === 0) return new Set();
  if (!sequentialUnlock) return new Set(modules.map((m) => m._id.toString()));

  const completionMap = await computeModuleCompletionMap({ modules, userId });
  return walkSequentialUnlock(modules, completionMap);
}

// =========================================================================
// Single-module convenience for enforcement points that only have a
// moduleId/categoryId in hand (GET /:id, recordCardCompletion) and haven't
// already loaded the whole category's module list. workspace-curriculum
// should NOT use this — it already has every category's modules loaded and
// should call getUnlockedModuleIds/computeModuleCompletionMap directly to
// keep the whole catalog's lock computation to one query batch total.
// =========================================================================
// `isVisible(moduleDoc) → boolean` (optional) restricts the chain to the
// modules this user can actually see — the same set workspace-curriculum
// walks. Without it, a module the user can never open (another
// department's / team's / region's) would sit in the chain uncompleted and
// lock every later module forever, while the Learn page shows them unlocked.
async function isModuleUnlockedForUser({ moduleId, categoryId, userId, isVisible, req }) {
  // 🧭 PATHS: once any Path is published, a module is open only if it is
  // unlocked in at least one published Path visible to this learner (see
  // services/paths.js). Required lazily — services/paths depends on this file.
  if (req) {
    const paths = require("../services/paths");
    if (await paths.pathsEnabled()) return paths.isModuleUnlockedInPaths(req, moduleId);
  }

  // Defensive only — every module always resolves to a real categoryId via
  // resolveCategoryId() at write time; fail-open rather than lock a module
  // that somehow has no category to walk against.
  if (!categoryId) return true;

  const category = await Category.findById(categoryId, "sequentialUnlock").lean();
  const sequentialUnlock = category ? category.sequentialUnlock !== false : true;
  if (!sequentialUnlock) return true;

  let siblingModules = await Module.find(
    { categoryId },
    "_id order hasTopics engineStrategy visibility departments targetTeams regions"
  ).lean();
  if (typeof isVisible === "function") {
    siblingModules = siblingModules.filter(
      (m) => m._id.toString() === moduleId.toString() || isVisible(m)
    );
  }

  const unlockedIds = await getUnlockedModuleIds({ modules: siblingModules, userId, sequentialUnlock });
  return unlockedIds.has(moduleId.toString());
}

module.exports = {
  computeModuleCompletionMap,
  walkSequentialUnlock,
  getUnlockedModuleIds,
  isModuleUnlockedForUser,
};
