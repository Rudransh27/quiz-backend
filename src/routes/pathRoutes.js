// src/routes/pathRoutes.js
//
// Admin Path builder (mounted at /api/paths; every route is admin-only).
//   GET    /?categoryId=           Paths of a Tag (drafts included) with module titles
//   POST   /                       create a draft Path
//   PUT    /:id                    edit name / description / modules / audience / flags
//   POST   /:id/publish            { published: true|false }
//   POST   /:id/duplicate          copy (modules + audience + questions) as a new draft
//   PUT    /reorder                { categoryId, pathIds: [...] }
//   DELETE /:id                    delete a Path (and its tests)
//   GET    /:id/form               the Pre/Post test: questions, bank coverage, problems
//   POST   /:id/form/generate      { perModule } build (or rebuild) the draft test from the bank
//   POST   /:id/form/swap          { kind, questionId } replace one question
//   POST   /:id/form/lock          freeze the draft — learners take locked tests only
// Questions themselves live in the module question bank (bankRoutes.js).
const express = require("express");
const mongoose = require("mongoose");
const auth = require("../middleware/auth");
const admin = require("../middleware/admin");
const Path = require("../models/Path");
const Module = require("../models/Module");
const Category = require("../models/Category");
const AssessmentForm = require("../models/AssessmentForm");
const forms = require("../services/formGenerator");
const { assertModuleViewAccess } = require("../utils/moduleAccess");
const { toIdArray } = require("../utils/scopeHelpers");
const { invalidatePathsEnabled } = require("../services/paths");
const { handleError } = require("../utils/safeError");

const router = express.Router();
const isValidId = (id) => mongoose.Types.ObjectId.isValid(String(id || ""));
const badRequest = (res, message) => res.status(400).json({ success: false, message });

async function loadCategoryForAdmin(req, categoryId) {
  if (!isValidId(categoryId)) return { error: [400, "Pick a valid tag."] };
  const category = await Category.findById(categoryId).lean();
  if (!category) return { error: [404, "Tag not found."] };
  const access = assertModuleViewAccess(category, req);
  if (!access.ok) return { error: [403, "You don't have access to this tag."] };
  return { category };
}

async function loadPathForAdmin(req, id) {
  if (!isValidId(id)) return { error: [400, "Invalid path id."] };
  const path = await Path.findById(id);
  if (!path) return { error: [404, "Path not found."] };
  const { error } = await loadCategoryForAdmin(req, path.categoryId);
  if (error) return { error };
  return { path };
}

// Only modules this admin can see may be put into a Path.
async function cleanModuleIds(req, raw) {
  const ids = [...new Set(toIdArray(raw))];
  if (!ids.length) return { ids: [] };
  const mods = await Module.find({ _id: { $in: ids } }, "visibility departments targetTeams regions").lean();
  const allowed = new Set(mods.filter((m) => assertModuleViewAccess(m, req).ok).map((m) => m._id.toString()));
  const rejected = ids.filter((id) => !allowed.has(id));
  if (rejected.length) return { error: `${rejected.length} module(s) don't exist or aren't available to you.` };
  return { ids };
}

const cleanAudience = (a = {}) => ({
  regions: toIdArray(a.regions),
  departments: toIdArray(a.departments),
  teams: toIdArray(a.teams),
});

async function withDetails(pathDocs) {
  const list = pathDocs.map((p) => (p.toObject ? p.toObject() : p));
  const moduleIds = [...new Set(list.flatMap((p) => (p.moduleIds || []).map(String)))];
  const [mods, formDocs] = await Promise.all([
    Module.find({ _id: { $in: moduleIds } }, "title visibility moduleType").lean(),
    AssessmentForm.find({ pathId: { $in: list.map((p) => p._id) } }, "pathId version status").sort({ version: 1 }).lean(),
  ]);
  const modMap = new Map(mods.map((m) => [m._id.toString(), m]));
  const testOf = new Map();
  formDocs.forEach((f) => {
    const t = testOf.get(String(f.pathId)) || { latestVersion: null, latestStatus: null, lockedVersion: null };
    t.latestVersion = f.version; t.latestStatus = f.status;
    if (f.status === "locked") t.lockedVersion = f.version;
    testOf.set(String(f.pathId), t);
  });
  return list.map((p) => ({
    ...p,
    modules: (p.moduleIds || []).map((id) => modMap.get(String(id))).filter(Boolean),
    test: testOf.get(p._id.toString()) || { latestVersion: null, latestStatus: null, lockedVersion: null },
  }));
}

// GET /api/paths?categoryId=
router.get("/", [auth, admin], async (req, res) => {
  try {
    const { categoryId } = req.query;
    const filter = {};
    if (categoryId) {
      const { error } = await loadCategoryForAdmin(req, categoryId);
      if (error) return res.status(error[0]).json({ success: false, message: error[1] });
      filter.categoryId = categoryId;
    }
    let list = await Path.find(filter).sort({ order: 1, createdAt: 1 }).lean();
    if (!categoryId && req.user.role !== "superadmin") {
      const cats = await Category.find({ _id: { $in: list.map((p) => p.categoryId) } }).lean();
      const ok = new Set(cats.filter((c) => assertModuleViewAccess(c, req).ok).map((c) => c._id.toString()));
      list = list.filter((p) => ok.has(p.categoryId.toString()));
    }
    return res.json({ success: true, data: await withDetails(list) });
  } catch (err) {
    return handleError(res, err, 500);
  }
});

// POST /api/paths
router.post("/", [auth, admin], async (req, res) => {
  try {
    const { categoryId, name, description, moduleIds, audience, sequentialUnlock, assessment } = req.body || {};
    const { error } = await loadCategoryForAdmin(req, categoryId);
    if (error) return res.status(error[0]).json({ success: false, message: error[1] });
    if (!name || !String(name).trim()) return badRequest(res, "Give the path a name.");
    const mods = await cleanModuleIds(req, moduleIds);
    if (mods.error) return badRequest(res, mods.error);

    const last = await Path.findOne({ categoryId }).sort({ order: -1 }).select("order").lean();
    const path = await Path.create({
      categoryId,
      name: String(name).trim(),
      description: description || "",
      moduleIds: mods.ids,
      audience: cleanAudience(audience),
      sequentialUnlock: sequentialUnlock !== false,
      assessment: {
        enabled: !!assessment?.enabled,
        questionsPerModule: Math.min(5, Math.max(1, Number(assessment?.questionsPerModule) || 2)),
      },
      order: last ? (Number(last.order) || 0) + 1 : 0,
      status: "draft",
      createdBy: req.user.id,
    });
    return res.status(201).json({ success: true, data: (await withDetails([path]))[0] });
  } catch (err) {
    return handleError(res, err, 400);
  }
});

// PUT /api/paths/reorder   { categoryId, pathIds }
router.put("/reorder", [auth, admin], async (req, res) => {
  try {
    const { categoryId, pathIds } = req.body || {};
    const { error } = await loadCategoryForAdmin(req, categoryId);
    if (error) return res.status(error[0]).json({ success: false, message: error[1] });
    const ids = toIdArray(pathIds);
    const owned = await Path.countDocuments({ _id: { $in: ids }, categoryId });
    if (owned !== ids.length) return badRequest(res, "Every path must belong to this tag.");
    await Promise.all(ids.map((id, i) => Path.updateOne({ _id: id }, { $set: { order: i } })));
    return res.json({ success: true });
  } catch (err) {
    return handleError(res, err, 400);
  }
});

// PUT /api/paths/:id
router.put("/:id", [auth, admin], async (req, res) => {
  try {
    const { path, error } = await loadPathForAdmin(req, req.params.id);
    if (error) return res.status(error[0]).json({ success: false, message: error[1] });
    const { name, description, moduleIds, audience, sequentialUnlock, assessment, categoryId } = req.body || {};

    if (name !== undefined) {
      if (!String(name).trim()) return badRequest(res, "Give the path a name.");
      path.name = String(name).trim();
    }
    if (description !== undefined) path.description = description || "";
    if (moduleIds !== undefined) {
      const mods = await cleanModuleIds(req, moduleIds);
      if (mods.error) return badRequest(res, mods.error);
      if (path.status === "published" && mods.ids.length === 0) return badRequest(res, "A published path needs at least one module.");
      path.moduleIds = mods.ids;
    }
    if (audience !== undefined) path.audience = cleanAudience(audience);
    if (sequentialUnlock !== undefined) path.sequentialUnlock = sequentialUnlock !== false;
    if (assessment !== undefined) {
      const enabling = !!assessment?.enabled;
      if (enabling && path.status === "published" && !(await forms.activeLockedForm(path._id))) {
        return badRequest(res, "Generate and lock the Pre/Post test before turning it on for a published path.");
      }
      path.set("assessment.enabled", enabling);
      if (assessment?.questionsPerModule !== undefined) {
        path.set("assessment.questionsPerModule", Math.min(5, Math.max(1, Number(assessment.questionsPerModule) || 2)));
      }
    }
    if (categoryId !== undefined && String(categoryId) !== String(path.categoryId)) {
      const target = await loadCategoryForAdmin(req, categoryId);
      if (target.error) return res.status(target.error[0]).json({ success: false, message: target.error[1] });
      path.categoryId = categoryId;
    }
    await path.save();
    return res.json({ success: true, data: (await withDetails([path]))[0] });
  } catch (err) {
    return handleError(res, err, 400);
  }
});

// POST /api/paths/:id/publish   { published: boolean }
router.post("/:id/publish", [auth, admin], async (req, res) => {
  try {
    const { path, error } = await loadPathForAdmin(req, req.params.id);
    if (error) return res.status(error[0]).json({ success: false, message: error[1] });
    const publish = req.body?.published !== false;
    if (publish) {
      if (!path.moduleIds.length) return badRequest(res, "Add at least one module before publishing.");
      if (path.assessment?.enabled && !(await forms.activeLockedForm(path._id))) {
        return badRequest(res, "Pre/Post is on: generate and lock the test before publishing.");
      }
    }
    path.status = publish ? "published" : "draft";
    await path.save();
    invalidatePathsEnabled();
    return res.json({ success: true, data: (await withDetails([path]))[0] });
  } catch (err) {
    return handleError(res, err, 400);
  }
});

// POST /api/paths/:id/duplicate
router.post("/:id/duplicate", [auth, admin], async (req, res) => {
  try {
    const { path, error } = await loadPathForAdmin(req, req.params.id);
    if (error) return res.status(error[0]).json({ success: false, message: error[1] });
    const last = await Path.findOne({ categoryId: path.categoryId }).sort({ order: -1 }).select("order").lean();
    const copy = await Path.create({
      categoryId: path.categoryId,
      name: `${path.name} (copy)`.slice(0, 120),
      description: path.description,
      moduleIds: path.moduleIds,
      audience: path.audience,
      sequentialUnlock: path.sequentialUnlock,
      // Questions live in the module bank, so the copy just needs its own
      // test generated (one click) — tests are never shared between paths.
      assessment: { enabled: !!path.assessment?.enabled, questionsPerModule: path.assessment?.questionsPerModule || 2 },
      order: last ? (Number(last.order) || 0) + 1 : 0,
      status: "draft",
      createdBy: req.user.id,
    });
    return res.status(201).json({ success: true, data: (await withDetails([copy]))[0] });
  } catch (err) {
    return handleError(res, err, 400);
  }
});

// DELETE /api/paths/:id
router.delete("/:id", [auth, admin], async (req, res) => {
  try {
    const { path, error } = await loadPathForAdmin(req, req.params.id);
    if (error) return res.status(error[0]).json({ success: false, message: error[1] });
    await AssessmentForm.deleteMany({ pathId: path._id });
    await path.deleteOne();
    invalidatePathsEnabled();
    return res.json({ success: true });
  } catch (err) {
    return handleError(res, err, 500);
  }
});

// ---------------- Pre/Post test (generated from the module bank) ----------------
const sendFormError = (res, err) => (err instanceof forms.FormError
  ? res.status(err.status).json({ success: false, message: err.message })
  : handleError(res, err, 500));

router.get("/:id/form", [auth, admin], async (req, res) => {
  try {
    const { path, error } = await loadPathForAdmin(req, req.params.id);
    if (error) return res.status(error[0]).json({ success: false, message: error[1] });
    return res.json({ success: true, data: await forms.formSummary(path._id) });
  } catch (err) { return sendFormError(res, err); }
});

router.post("/:id/form/generate", [auth, admin], async (req, res) => {
  try {
    const { path, error } = await loadPathForAdmin(req, req.params.id);
    if (error) return res.status(error[0]).json({ success: false, message: error[1] });
    return res.json({ success: true, data: await forms.generateForm(path._id, { perModule: req.body?.perModule, userId: req.user.id }) });
  } catch (err) { return sendFormError(res, err); }
});

router.post("/:id/form/swap", [auth, admin], async (req, res) => {
  try {
    const { path, error } = await loadPathForAdmin(req, req.params.id);
    if (error) return res.status(error[0]).json({ success: false, message: error[1] });
    return res.json({ success: true, data: await forms.swapQuestion(path._id, { kind: req.body?.kind, questionId: req.body?.questionId }) });
  } catch (err) { return sendFormError(res, err); }
});

router.post("/:id/form/lock", [auth, admin], async (req, res) => {
  try {
    const { path, error } = await loadPathForAdmin(req, req.params.id);
    if (error) return res.status(error[0]).json({ success: false, message: error[1] });
    return res.json({ success: true, data: await forms.lockForm(path._id, req.user.id) });
  } catch (err) { return sendFormError(res, err); }
});

module.exports = router;
