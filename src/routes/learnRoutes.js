// src/routes/learnRoutes.js
//
// Learner-facing Learn navigation: Tag → Path → modules.
//   GET /api/learn/tags                 Tags with ≥1 Path visible to this learner
//                                       (+ `paths`: every visible Path, with progress)
//   GET /api/learn/tags/:id/paths       those Paths, with this learner's progress
//   GET /api/learn/paths/:id            one Path: ordered modules + lock/progress + Pre/Post state
//   GET /api/learn/legacy-path          ?categoryId=&regionId= → the Path an old
//                                       /orbit/tags/:cat/region/:region link should open
// Answer keys never appear here (module summaries only — no card content).
const express = require("express");
const mongoose = require("mongoose");
const auth = require("../middleware/auth");
const Category = require("../models/Category");
const Path = require("../models/Path");
const Card = require("../models/Card");
const Topic = require("../models/Topic");
const { assertModuleViewAccess } = require("../utils/moduleAccess");
const { computePointsReward } = require("../utils/pointsCalculator");
const paths = require("../services/paths");
const { handleError } = require("../utils/safeError");

const router = express.Router();
const isValidId = (id) => mongoose.Types.ObjectId.isValid(String(id || ""));
const isPrivileged = (req) => req.user.role === "admin" || req.user.role === "superadmin";

const summarizePathState = (s) => ({
  _id: s.path._id,
  categoryId: s.path.categoryId,
  name: s.path.name,
  description: s.path.description || "",
  order: s.path.order,
  status: s.path.status,
  moduleCount: s.totalCount,
  completedCount: s.completedCount,
  percent: s.totalCount ? Math.round((s.completedCount / s.totalCount) * 100) : 0,
  assessment: s.assessment,
  audience: s.path.audience,
});

// GET /api/learn/tags
router.get("/tags", auth, async (req, res) => {
  try {
    const states = await paths.visiblePathStates(req);
    const byCategory = new Map();
    states.forEach((s) => {
      const key = s.path.categoryId.toString();
      const agg = byCategory.get(key) || { pathCount: 0, moduleIds: new Set(), completed: new Set() };
      agg.pathCount += 1;
      s.modules.forEach((m) => {
        agg.moduleIds.add(m.module._id.toString());
        if (m.completed) agg.completed.add(m.module._id.toString());
      });
      byCategory.set(key, agg);
    });
    const categories = byCategory.size
      ? await Category.find({ _id: { $in: [...byCategory.keys()] } }).sort({ order: 1, name: 1 }).lean()
      : [];
    const data = categories
      .filter((c) => assertModuleViewAccess(c, req).ok)
      .map((c) => {
        const agg = byCategory.get(c._id.toString());
        return {
          _id: c._id,
          name: c.name,
          description: c.description || "",
          order: c.order,
          isDefault: !!c.isDefault,
          pathCount: agg.pathCount,
          moduleCount: agg.moduleIds.size,
          completedModuleCount: agg.completed.size,
        };
      });
    // Every visible Path too (same summaries as /tags/:id/paths), so the
    // Learn page can show and filter Paths by Tag without a request per Tag.
    // Only Paths whose Tag passed the access check above are included.
    const allowed = new Set(data.map((c) => c._id.toString()));
    const pathList = states.filter((s) => allowed.has(s.path.categoryId.toString())).map(summarizePathState);
    // pathsEnabled=false (no Path published yet) lets the Learn page fall
    // back to the old Tag → Region flow instead of showing nothing.
    return res.json({ success: true, pathsEnabled: await paths.pathsEnabled(), data, paths: pathList });
  } catch (err) {
    return handleError(res, err, 500);
  }
});

// GET /api/learn/tags/:id/paths
router.get("/tags/:id/paths", auth, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid tag id." });
    const category = await Category.findById(req.params.id).lean();
    if (!category) return res.status(404).json({ success: false, message: "Tag not found." });
    const access = assertModuleViewAccess(category, req);
    if (!access.ok) return res.status(access.status).json({ success: false, message: access.message });

    const states = await paths.visiblePathStates(req, { categoryId: category._id });
    return res.json({
      success: true,
      pathsEnabled: await paths.pathsEnabled(),
      category: { _id: category._id, name: category.name, description: category.description || "" },
      data: states.map(summarizePathState),
    });
  } catch (err) {
    return handleError(res, err, 500);
  }
});

// Card ids per module (direct cards + cards under the module's topics), for
// the journey's per-module progress ring and point totals.
async function cardInfoByModule(moduleIds) {
  const topics = await Topic.find({ module_id: { $in: moduleIds } }, "module_id").lean();
  const topicToModule = new Map(topics.map((t) => [t._id.toString(), t.module_id.toString()]));
  const cards = await Card.find(
    { $or: [{ module_id: { $in: moduleIds } }, { topic_id: { $in: topics.map((t) => t._id) } }] },
    "module_id topic_id card_type content.htmlSource",
  ).lean();
  const out = new Map();
  cards.forEach((c) => {
    const mid = c.module_id ? c.module_id.toString() : topicToModule.get(c.topic_id?.toString());
    if (!mid) return;
    const entry = out.get(mid) || { ids: [], cards: [] };
    entry.ids.push(c._id);
    entry.cards.push(c);
    out.set(mid, entry);
  });
  return out;
}

// GET /api/learn/paths/:id
router.get("/paths/:id", auth, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid path id." });
    const path = await Path.findById(req.params.id).lean();
    if (!path) return res.status(404).json({ success: false, message: "Path not found." });
    // Learners only ever see published Paths meant for them; admins may
    // preview drafts from the Path builder.
    if (!isPrivileged(req) && (path.status !== "published" || !paths.audienceMatches(path, req))) {
      return res.status(404).json({ success: false, message: "Path not found." });
    }
    const category = await Category.findById(path.categoryId, "name").lean();
    const [state] = await paths.computePathStates(req, [path]);
    if (!isPrivileged(req) && state.totalCount === 0) {
      return res.status(404).json({ success: false, message: "Path not found." });
    }

    const info = await cardInfoByModule(state.modules.map((m) => m.module._id));
    const modules = state.modules.map(({ module: m, completed, unlocked }) => {
      const ci = info.get(m._id.toString()) || { ids: [], cards: [] };
      return {
        _id: m._id,
        title: m.title,
        description: m.description || "",
        imageUrl: m.imageUrl || "",
        hasTopics: m.hasTopics,
        engineStrategy: m.engineStrategy,
        moduleType: m.moduleType,
        estimatedTime: m.estimatedTime || 0,
        allCardIds: ci.ids,
        totalCardCount: ci.ids.length,
        pointsReward: computePointsReward(ci.cards),
        completed,
        locked: !unlocked,
      };
    });

    return res.json({
      success: true,
      data: {
        ...summarizePathState(state),
        category: category ? { _id: category._id, name: category.name } : null,
        sequentialUnlock: path.sequentialUnlock !== false,
        modules,
      },
    });
  } catch (err) {
    return handleError(res, err, 500);
  }
});

// GET /api/learn/legacy-path?categoryId=&regionId=  (regionId may be "all")
router.get("/legacy-path", auth, async (req, res) => {
  try {
    const { categoryId, regionId } = req.query;
    if (!isValidId(categoryId)) return res.status(400).json({ success: false, message: "Invalid tag id." });
    const states = await paths.visiblePathStates(req, { categoryId });
    if (!states.length) return res.json({ success: true, pathId: null });
    let match = null;
    if (isValidId(regionId)) {
      match = states.find((s) => (s.path.audience?.regions || []).some((r) => r.toString() === String(regionId)));
    }
    return res.json({ success: true, pathId: (match || states[0]).path._id });
  } catch (err) {
    return handleError(res, err, 500);
  }
});

module.exports = router;
