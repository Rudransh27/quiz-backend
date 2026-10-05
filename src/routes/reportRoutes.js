// src/routes/reportRoutes.js  (mounted at /api/reports)
//
// Admin reports about individual learners (services/learnerReport.js).
//   GET /learners?departmentId=&teamId=&regionId=&format=csv   one row per learner in scope
//   GET /learners/:userId?format=csv                         one learner: paths, modules, totals
//   GET /learners/:userId/modules/:moduleId                  one module, question by question
// A department admin sees learners in their own department; a superadmin
// sees everyone (optionally narrowed to one department).
const express = require("express");
const auth = require("../middleware/auth");
const admin = require("../middleware/admin");
const report = require("../services/learnerReport");
const { resolveAnalyticsUserScope } = require("../controllers/progressController");
const { buildCsv } = require("../utils/csvBuilder");
const { handleError } = require("../utils/safeError");

const router = express.Router();

const sendError = (res, err) => (err instanceof report.ReportError
  ? res.status(err.status).json({ success: false, message: err.message })
  : handleError(res, err, 500));

const sendCsv = (res, filename, headers, rows) => {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  return res.status(200).send(buildCsv(headers, rows));
};
const fmt = (v) => (v === null || v === undefined ? "" : v);
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "");
const minutes = (s) => Math.round((s || 0) / 60);
const STATUS = { completed: "Completed", in_progress: "In progress", not_started: "Not started" };
const SOURCE = { post: "Post-check", in_module: "In-module" };
const safeName = (s) => String(s || "learner").replace(/[^\w-]+/g, "_").slice(0, 60);

router.get("/learners", [auth, admin], async (req, res) => {
  try {
    const { userIds } = await resolveAnalyticsUserScope(req);
    const rows = await report.learnerRoster(userIds);
    if (req.query.format === "csv") {
      return sendCsv(res, "learner-report.csv",
        ["Name", "Email", "Department", "Team", "Regions", "Modules completed", "Modules started", "In-module score %", "Questions answered", "Answered before first-try tracking", "Written answers awaiting grading", "Pre-check avg %", "Post-check avg %", "Time (min)", "Last active", "Lightyears"],
        rows.map((r) => [r.username, r.email, r.department, r.team, r.regions.join("; "), r.modulesCompleted, r.modulesStarted, fmt(r.score.percent), r.score.answered, r.score.recorded, r.writtenPending, fmt(r.preAvg), fmt(r.postAvg), minutes(r.timeSeconds), day(r.lastActive), r.xp]));
    }
    return res.json({ success: true, data: rows, lowScore: report.LOW_SCORE });
  } catch (err) { return sendError(res, err); }
});

router.get("/learners/:userId", [auth, admin], async (req, res) => {
  try {
    const data = await report.learnerReport(req, req.params.userId);
    if (req.query.format === "csv") {
      const pathRows = data.paths.map((p) => [
        "Path", p.name, p.status, `${p.modulesCompleted}/${p.modulesTotal}`, fmt(p.inModule.percent),
        fmt(p.pre?.percent), fmt(p.post?.percent), fmt(p.improvement),
        p.outcome ? `${p.outcome.percent} (${SOURCE[p.outcome.source]})` : "", "", "",
      ]);
      const moduleRows = data.modules.map((m) => [
        "Module", m.title, STATUS[m.status], `${m.progress.percent}%`, fmt(m.score.percent),
        "", "", "", `${m.score.correct}/${m.score.answered} right first time${m.score.recorded ? ` (${m.score.recorded} recorded before first-try tracking)` : ""}`,
        minutes(m.timeSeconds), day(m.lastActive),
      ]);
      return sendCsv(res, `learner-${safeName(data.user.username)}.csv`,
        ["Type", "Name", "Status", "Progress", "In-module score %", "Pre %", "Post %", "Improvement (points)", "Detail", "Time (min)", "Last active"],
        [...pathRows, ...moduleRows]);
    }
    return res.json({ success: true, data });
  } catch (err) { return sendError(res, err); }
});

router.get("/learners/:userId/modules/:moduleId", [auth, admin], async (req, res) => {
  try {
    return res.json({ success: true, data: await report.learnerModuleDetail(req, req.params.userId, req.params.moduleId) });
  } catch (err) { return sendError(res, err); }
});

module.exports = router;
