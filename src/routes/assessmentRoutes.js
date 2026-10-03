// src/routes/assessmentRoutes.js  (mounted at /api/assessments)
//
// Learner
//   GET  /paths/:pathId/result            my Post result (+ Pre% for the improvement line)
//   GET  /paths/:pathId/:kind             questions to answer (kind = pre | post), no answers
//   POST /paths/:pathId/:kind             { answers: [{questionId, selectedOption}] }
// Admin (reports — questions live in the module bank, tests in pathRoutes)
//   GET    /admin/report?categoryId=&departmentId=&teamId=&format=csv   one row per Path
//   GET    /admin/report/paths/:pathId?format=csv                       per learner + per module + per question
const express = require("express");
const mongoose = require("mongoose");
const rateLimit = require("express-rate-limit");
const auth = require("../middleware/auth");
const admin = require("../middleware/admin");
const Path = require("../models/Path");
const Category = require("../models/Category");
const assessments = require("../services/assessments");
const { assertModuleViewAccess } = require("../utils/moduleAccess");
const { resolveAnalyticsUserScope } = require("../controllers/progressController");
const { buildCsv } = require("../utils/csvBuilder");
const { handleError } = require("../utils/safeError");

const router = express.Router();
const isValidId = (id) => mongoose.Types.ObjectId.isValid(String(id || ""));

const submitLimiter = rateLimit({
  windowMs: 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => `u:${req.user.id}`,
  message: { success: false, message: "Too many submissions. Please wait a moment." },
});

const sendError = (res, err) => (err instanceof assessments.AssessmentError
  ? res.status(err.status).json({ success: false, message: err.message })
  : handleError(res, err, 500));

// ---------------- admin: reports ----------------
async function loadPathForAdmin(req, pathId) {
  if (!isValidId(pathId)) return { error: [400, "Invalid path id."] };
  const path = await Path.findById(pathId);
  if (!path) return { error: [404, "Path not found."] };
  const category = await Category.findById(path.categoryId).lean();
  if (!category || !assertModuleViewAccess(category, req).ok) return { error: [403, "You don't have access to this path."] };
  return { path };
}

const sendCsv = (res, filename, headers, rows) => {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  return res.status(200).send(buildCsv(headers, rows));
};
const fmt = (v) => (v === null || v === undefined ? "" : v);

router.get("/admin/report", [auth, admin], async (req, res) => {
  try {
    const { userIds } = await resolveAnalyticsUserScope(req);
    const filter = { "assessment.enabled": true };
    if (req.query.categoryId && isValidId(req.query.categoryId)) filter.categoryId = req.query.categoryId;
    let list = await Path.find(filter).sort({ categoryId: 1, order: 1 }).lean();
    const cats = await Category.find({ _id: { $in: list.map((p) => p.categoryId) } }, "name visibility departments targetTeams regions").lean();
    const catMap = new Map(cats.map((c) => [String(c._id), c]));
    list = list.filter((p) => catMap.has(String(p.categoryId)) && assertModuleViewAccess(catMap.get(String(p.categoryId)), req).ok);

    const rows = [];
    for (const p of list) {
      const { summary } = await assessments.pathReport(p, userIds);
      rows.push({ pathId: p._id, path: p.name, tag: catMap.get(String(p.categoryId))?.name || "", status: p.status, moduleCount: (p.moduleIds || []).length, ...summary });
    }
    if (req.query.format === "csv") {
      return sendCsv(res, "pre-post-report.csv",
        ["Tag", "Path", "Status", "Modules", "Started", "Pre done", "Post done", "Completed path", "Pre avg %", "Post avg %", "Avg improvement (points)", "Learners with both", "No baseline"],
        rows.map((r) => [r.tag, r.path, r.status, r.moduleCount, r.started, r.preDone, r.postDone, r.completedPath, fmt(r.preAvg), fmt(r.postAvg), fmt(r.improvementAvg), r.pairedCount, r.noBaseline]));
    }
    return res.json({ success: true, data: rows });
  } catch (err) { return handleError(res, err, 500); }
});

router.get("/admin/report/paths/:pathId", [auth, admin], async (req, res) => {
  try {
    const { path, error } = await loadPathForAdmin(req, req.params.pathId);
    if (error) return res.status(error[0]).json({ success: false, message: error[1] });
    const { userIds } = await resolveAnalyticsUserScope(req);
    const { learners, summary, byModule, byQuestion } = await assessments.pathReport(path.toObject(), userIds);
    const data = (await assessments.attachUsers(learners)).sort((a, b) => a.username.localeCompare(b.username));
    const statusOf = (l) => (l.postPercent !== null ? "Complete"
      : l.modulesCompleted >= l.modulesTotal && l.modulesTotal > 0 ? "Post-check pending"
        : "In progress");
    if (req.query.format === "csv") {
      return sendCsv(res, `pre-post-${path.name.replace(/[^\w-]+/g, "_")}.csv`,
        ["Name", "Email", "Department", "Team", "Pre %", "Post %", "Improvement (points)", "Modules completed", "Modules total", "Status", "Baseline"],
        data.map((l) => [l.username, l.email, l.department, l.team, fmt(l.prePercent), fmt(l.postPercent), fmt(l.improvement), l.modulesCompleted, l.modulesTotal, statusOf(l), l.noBaseline ? "No baseline" : ""]));
    }
    return res.json({
      success: true,
      path: { _id: path._id, name: path.name, moduleCount: path.moduleIds.length },
      summary,
      byModule,
      byQuestion,
      data: data.map((l) => ({ ...l, status: statusOf(l) })),
    });
  } catch (err) { return handleError(res, err, 500); }
});

// ---------------- learner ----------------
router.get("/paths/:pathId/result", auth, async (req, res) => {
  try {
    return res.json({ success: true, data: await assessments.learnerResult(req, req.params.pathId) });
  } catch (err) { return sendError(res, err); }
});

router.get("/paths/:pathId/:kind", auth, async (req, res) => {
  try {
    return res.json({ success: true, data: await assessments.startAssessment(req, req.params.pathId, req.params.kind) });
  } catch (err) { return sendError(res, err); }
});

router.post("/paths/:pathId/:kind", auth, submitLimiter, async (req, res) => {
  try {
    const data = await assessments.submitAssessment(req, req.params.pathId, req.params.kind, req.body?.answers);
    return res.status(201).json({ success: true, data });
  } catch (err) { return sendError(res, err); }
});

module.exports = router;
