// src/routes/bankRoutes.js  (mounted at /api/bank; admin only)
//
// The module question bank — where Pre/Post questions are written.
//   GET    /modules?search=                    modules this admin can see, with bank counts
//   GET    /modules/:moduleId/questions        ?status=draft|active|retired (answers included)
//   POST   /modules/:moduleId/questions        create
//   PUT    /questions/:id                      edit (question, options, correctIndex, explanation, difficulty, status)
//   POST   /questions/:id/approve              draft → active
//   DELETE /questions/:id                      delete; retired instead if any test or attempt used it
//   POST   /import                             { rows, dryRun } — rows from the Excel/CSV template
//   POST   /modules/:moduleId/ai-draft         { count } — Claude drafts questions as "draft"
const express = require("express");
const mongoose = require("mongoose");
const rateLimit = require("express-rate-limit");
const auth = require("../middleware/auth");
const admin = require("../middleware/admin");
const Module = require("../models/Module");
const BankQuestion = require("../models/BankQuestion");
const AssessmentForm = require("../models/AssessmentForm");
const AssessmentAttempt = require("../models/AssessmentAttempt");
const { assertModuleViewAccess } = require("../utils/moduleAccess");
const { draftQuestions, AiDraftError } = require("../services/aiQuestionDrafts");
const { handleError } = require("../utils/safeError");

const router = express.Router();
const isValidId = (id) => mongoose.Types.ObjectId.isValid(String(id || ""));
const DIFFICULTIES = ["easy", "medium", "hard"];
const MAX_IMPORT_ROWS = 1000;

const aiLimiter = rateLimit({
  windowMs: 60 * 1000, max: 6, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => `u:${req.user.id}`,
  message: { success: false, message: "Too many AI drafting requests. Please wait a minute." },
});

async function loadModule(req, moduleId) {
  if (!isValidId(moduleId)) return { error: [400, "Invalid module id."] };
  const mod = await Module.findById(moduleId, "title visibility departments targetTeams regions categoryId").lean();
  if (!mod) return { error: [404, "Module not found."] };
  if (!assertModuleViewAccess(mod, req).ok) return { error: [403, "You don't have access to this module."] };
  return { mod };
}

async function loadQuestion(req, id) {
  if (!isValidId(id)) return { error: [400, "Invalid question id."] };
  const q = await BankQuestion.findById(id).select("+correctIndex +explanation");
  if (!q) return { error: [404, "Question not found."] };
  const { error } = await loadModule(req, q.moduleId);
  if (error) return { error };
  return { q };
}

const fail = (res, error) => res.status(error[0]).json({ success: false, message: error[1] });

function cleanFields(body) {
  const out = {};
  if (body.question !== undefined) out.question = String(body.question ?? "").trim();
  if (body.options !== undefined) out.options = (Array.isArray(body.options) ? body.options : []).map((o) => String(o ?? "").trim()).filter(Boolean);
  if (body.correctIndex !== undefined) out.correctIndex = Number(body.correctIndex);
  if (body.explanation !== undefined) out.explanation = String(body.explanation ?? "").trim();
  if (body.difficulty !== undefined) out.difficulty = DIFFICULTIES.includes(body.difficulty) ? body.difficulty : "medium";
  if (body.status !== undefined && ["draft", "active", "retired"].includes(body.status)) out.status = body.status;
  return out;
}

// GET /api/bank/modules?search=
router.get("/modules", [auth, admin], async (req, res) => {
  try {
    const term = String(req.query.search || "").trim().toLowerCase();
    const mods = (await Module.find({}, "title visibility departments targetTeams regions categoryId order").sort({ title: 1 }).lean())
      .filter((m) => assertModuleViewAccess(m, req).ok)
      .filter((m) => !term || (m.title || "").toLowerCase().includes(term));
    const counts = await BankQuestion.aggregate([
      { $match: { moduleId: { $in: mods.map((m) => m._id) } } },
      { $group: { _id: { m: "$moduleId", s: "$status", d: "$difficulty" }, n: { $sum: 1 } } },
    ]);
    const by = new Map(mods.map((m) => [String(m._id), { active: 0, draft: 0, retired: 0, easy: 0, medium: 0, hard: 0 }]));
    counts.forEach(({ _id, n }) => {
      const c = by.get(String(_id.m));
      if (!c) return;
      c[_id.s] += n;
      if (_id.s === "active") c[_id.d] += n;
    });
    return res.json({ success: true, data: mods.map((m) => ({ _id: m._id, title: m.title, categoryId: m.categoryId, bank: by.get(String(m._id)) })) });
  } catch (err) { return handleError(res, err, 500); }
});

// GET /api/bank/modules/:moduleId/questions
router.get("/modules/:moduleId/questions", [auth, admin], async (req, res) => {
  try {
    const { mod, error } = await loadModule(req, req.params.moduleId);
    if (error) return fail(res, error);
    const filter = { moduleId: mod._id };
    if (["draft", "active", "retired"].includes(req.query.status)) filter.status = req.query.status;
    const data = await BankQuestion.find(filter).select("+correctIndex +explanation").sort({ status: 1, createdAt: 1 }).lean();
    return res.json({ success: true, module: { _id: mod._id, title: mod.title }, data });
  } catch (err) { return handleError(res, err, 500); }
});

// POST /api/bank/modules/:moduleId/questions
router.post("/modules/:moduleId/questions", [auth, admin], async (req, res) => {
  try {
    const { mod, error } = await loadModule(req, req.params.moduleId);
    if (error) return fail(res, error);
    const fields = cleanFields(req.body || {});
    const q = await BankQuestion.create({ status: "active", ...fields, moduleId: mod._id, source: "manual", createdBy: req.user.id });
    const data = await BankQuestion.findById(q._id).select("+correctIndex +explanation").lean();
    return res.status(201).json({ success: true, data });
  } catch (err) { return handleError(res, err, 400); }
});

// PUT /api/bank/questions/:id
router.put("/questions/:id", [auth, admin], async (req, res) => {
  try {
    const { q, error } = await loadQuestion(req, req.params.id);
    if (error) return fail(res, error);
    Object.assign(q, cleanFields(req.body || {}));
    await q.save();
    return res.json({ success: true, data: q.toObject() });
  } catch (err) { return handleError(res, err, 400); }
});

// POST /api/bank/questions/:id/approve
router.post("/questions/:id/approve", [auth, admin], async (req, res) => {
  try {
    const { q, error } = await loadQuestion(req, req.params.id);
    if (error) return fail(res, error);
    q.status = "active";
    await q.save();
    return res.json({ success: true, data: q.toObject() });
  } catch (err) { return handleError(res, err, 400); }
});

// DELETE /api/bank/questions/:id
router.delete("/questions/:id", [auth, admin], async (req, res) => {
  try {
    const { q, error } = await loadQuestion(req, req.params.id);
    if (error) return fail(res, error);
    const used = await AssessmentForm.exists({ $or: [{ "pre.questionId": q._id }, { "post.questionId": q._id }] })
      || await AssessmentAttempt.exists({ "answers.questionId": q._id });
    if (used) {
      q.status = "retired";
      await q.save();
      return res.json({ success: true, retired: true, message: "This question was used in a test, so it was retired (kept for past results) instead of deleted." });
    }
    await q.deleteOne();
    return res.json({ success: true, deleted: true });
  } catch (err) { return handleError(res, err, 500); }
});

// POST /api/bank/import  { rows: [{Module, Question, A..F, Correct, Explanation, Difficulty}], dryRun }
router.post("/import", [auth, admin], async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    const dryRun = req.body?.dryRun !== false;
    if (!rows.length) return res.status(400).json({ success: false, message: "The file has no rows." });
    if (rows.length > MAX_IMPORT_ROWS) return res.status(400).json({ success: false, message: `Import at most ${MAX_IMPORT_ROWS} rows at a time.` });

    const modules = (await Module.find({}, "title visibility departments targetTeams regions").lean()).filter((m) => assertModuleViewAccess(m, req).ok);
    const byTitle = new Map();
    modules.forEach((m) => {
      const k = String(m.title || "").trim().toLowerCase();
      byTitle.set(k, byTitle.has(k) ? "AMBIGUOUS" : m);
    });
    const byId = new Map(modules.map((m) => [String(m._id), m]));
    const get = (row, key) => {
      const hit = Object.keys(row || {}).find((k) => k.trim().toLowerCase() === key.toLowerCase());
      return hit === undefined ? "" : String(row[hit] ?? "").trim();
    };

    const results = rows.map((row, i) => {
      const errors = [];
      const modRef = get(row, "Module");
      let mod = byId.get(modRef) || byTitle.get(modRef.toLowerCase());
      if (mod === "AMBIGUOUS") { errors.push(`Two modules are called "${modRef}" — use the module id instead.`); mod = null; }
      else if (!mod) errors.push(modRef ? `Module "${modRef}" not found (or not available to you).` : "Module is empty.");
      const question = get(row, "Question");
      if (!question) errors.push("Question is empty.");
      const letters = ["A", "B", "C", "D", "E", "F"];
      const options = letters.map((l) => get(row, l)).filter(Boolean);
      if (options.length < 2) errors.push("Give at least two options (columns A, B, …).");
      const correct = get(row, "Correct").toUpperCase();
      const correctIndex = letters.indexOf(correct);
      if (correctIndex < 0 || !get(row, letters[correctIndex] || "")) errors.push(`Correct must be the letter of a filled option (got "${correct}").`);
      const diff = get(row, "Difficulty").toLowerCase() || "medium";
      if (!DIFFICULTIES.includes(diff)) errors.push(`Difficulty must be easy, medium or hard (got "${diff}").`);
      // Options are compacted (blank columns dropped) — map the correct letter accordingly.
      const filledLetters = letters.filter((l) => get(row, l));
      return {
        row: i + 2, // +1 header, +1 1-based
        errors,
        doc: errors.length ? null : {
          moduleId: mod._id, question, options, correctIndex: filledLetters.indexOf(correct),
          explanation: get(row, "Explanation"), difficulty: diff, status: "active", source: "import", createdBy: req.user.id,
        },
        module: mod ? mod.title : modRef,
        question,
      };
    });

    const valid = results.filter((r) => r.doc);
    let imported = 0;
    if (!dryRun && valid.length) imported = (await BankQuestion.insertMany(valid.map((r) => r.doc))).length;
    return res.json({
      success: true,
      dryRun,
      total: rows.length,
      valid: valid.length,
      imported,
      errors: results.filter((r) => r.errors.length).map(({ row, module, question, errors }) => ({ row, module, question, errors })),
    });
  } catch (err) { return handleError(res, err, 400); }
});

// POST /api/bank/modules/:moduleId/ai-draft  { count }
router.post("/modules/:moduleId/ai-draft", [auth, admin], aiLimiter, async (req, res) => {
  try {
    const { mod, error } = await loadModule(req, req.params.moduleId);
    if (error) return fail(res, error);
    const out = await draftQuestions(mod._id, { count: req.body?.count, userId: req.user.id });
    return res.status(201).json({ success: true, ...out });
  } catch (err) {
    if (err instanceof AiDraftError) return res.status(err.status).json({ success: false, message: err.message });
    return handleError(res, err, 500);
  }
});

module.exports = router;
