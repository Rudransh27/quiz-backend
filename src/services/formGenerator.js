// src/services/formGenerator.js
//
// Builds a Path's fixed Pre-check and Post-check from the module question
// bank. For every module in the Path it picks `perModule` questions for Pre
// and `perModule` DIFFERENT questions for Post, matched in pairs of the same
// difficulty — so both tests cover every module equally and are equally hard,
// which is what makes "40% → 80%" a fair comparison.
//
//   pickForModule()  pure selection logic (unit-tested)
//   generateForm()   create/replace the Path's draft test
//   swapQuestion()   replace one question with another of the same module
//   lockForm()       freeze a draft — learners only ever take locked tests
//   formSummary()    the current/active test with question details for admins
const mongoose = require("mongoose");
const Path = require("../models/Path");
const Module = require("../models/Module");
const BankQuestion = require("../models/BankQuestion");
const AssessmentForm = require("../models/AssessmentForm");

const DIFFICULTIES = ["easy", "medium", "hard"];
const ROTATION = ["medium", "easy", "hard"]; // first pair medium, then easy, then hard, ...
const RANK = { easy: 0, medium: 1, hard: 2 };

class FormError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function shuffle(list, rand = Math.random) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Pure: choose Pre/Post questions for ONE module.
//   pool: [{ _id, difficulty }] — ACTIVE bank questions of the module
// Returns { pre: [...ids], post: [...ids], need, have, shortage, mismatched }
//   mismatched = pairs whose Pre and Post question differ in difficulty
function pickForModule(pool, perModule, rand = Math.random) {
  const need = perModule * 2;
  const buckets = Object.fromEntries(DIFFICULTIES.map((d) => [d, []]));
  shuffle(pool, rand).forEach((q) => (buckets[q.difficulty] || buckets.medium).push(q));
  const pre = [];
  const post = [];
  let mismatched = 0;

  for (let k = 0; k < perModule; k++) {
    const order = [...ROTATION.slice(k % 3), ...ROTATION.slice(0, k % 3)];
    const same = order.find((d) => buckets[d].length >= 2);
    let a; let b;
    if (same) {
      [a, b] = buckets[same].splice(0, 2);
    } else {
      // No difficulty has two left: pair the closest two that remain.
      const left = DIFFICULTIES.filter((d) => buckets[d].length > 0);
      if (left.length < 2) break;
      const [d1, d2] = left
        .flatMap((x, i) => left.slice(i + 1).map((y) => [x, y]))
        .sort((p, q) => Math.abs(RANK[p[0]] - RANK[p[1]]) - Math.abs(RANK[q[0]] - RANK[q[1]]))[0];
      a = buckets[d1].shift();
      b = buckets[d2].shift();
      mismatched++;
    }
    // Which of the pair goes to Pre is random, so neither test is
    // systematically the "first-written" one.
    if (rand() < 0.5) [a, b] = [b, a];
    pre.push(a);
    post.push(b);
  }
  return {
    pre: pre.map((q) => q._id),
    post: post.map((q) => q._id),
    need,
    have: pool.length,
    shortage: Math.max(0, need - pool.length),
    mismatched,
  };
}

const idStr = (v) => String(v && v._id ? v._id : v);

async function currentForm(pathId) {
  return AssessmentForm.findOne({ pathId }).sort({ version: -1 });
}

// The test learners take now: the newest LOCKED version.
async function activeLockedForm(pathId) {
  return AssessmentForm.findOne({ pathId, status: "locked" }).sort({ version: -1 }).lean();
}

async function generateForm(pathId, { perModule, userId } = {}) {
  const path = await Path.findById(pathId);
  if (!path) throw new FormError(404, "Path not found.");
  if (!path.moduleIds.length) throw new FormError(400, "Add modules to the path first.");
  const n = Math.min(5, Math.max(1, Number(perModule) || path.assessment?.questionsPerModule || 2));
  if (path.assessment?.questionsPerModule !== n) {
    path.set("assessment.questionsPerModule", n);
    await path.save();
  }

  const pools = await BankQuestion.find({ moduleId: { $in: path.moduleIds }, status: "active" }, "moduleId difficulty").lean();
  const byModule = new Map();
  pools.forEach((q) => {
    const k = idStr(q.moduleId);
    if (!byModule.has(k)) byModule.set(k, []);
    byModule.get(k).push(q);
  });

  const pre = []; const post = [];
  path.moduleIds.forEach((mid) => {
    const pick = pickForModule(byModule.get(idStr(mid)) || [], n);
    pick.pre.forEach((qid) => pre.push({ questionId: qid, moduleId: mid }));
    pick.post.forEach((qid) => post.push({ questionId: qid, moduleId: mid }));
  });

  let form = await currentForm(path._id);
  if (form && form.status === "draft") {
    Object.assign(form, { perModule: n, moduleIds: path.moduleIds, pre, post, createdBy: userId || form.createdBy });
    await form.save();
  } else {
    form = await AssessmentForm.create({
      pathId: path._id, version: form ? form.version + 1 : 1, status: "draft",
      perModule: n, moduleIds: path.moduleIds, pre, post, createdBy: userId || null,
    });
  }
  return formSummary(path._id);
}

async function swapQuestion(pathId, { kind, questionId }) {
  if (!["pre", "post"].includes(kind)) throw new FormError(400, "Say which test: pre or post.");
  const form = await currentForm(pathId);
  if (!form || form.status !== "draft") throw new FormError(409, "Only a draft test can be changed. Generate a new version first.");
  const slot = form[kind].find((s) => idStr(s.questionId) === String(questionId));
  if (!slot) throw new FormError(404, "That question isn't in this test.");

  const current = await BankQuestion.findById(slot.questionId, "difficulty").lean();
  const used = new Set([...form.pre, ...form.post].map((s) => idStr(s.questionId)));
  const candidates = (await BankQuestion.find({ moduleId: slot.moduleId, status: "active" }, "difficulty").lean())
    .filter((q) => !used.has(idStr(q._id)));
  if (!candidates.length) throw new FormError(409, "No other unused questions for this module — add more to its bank.");
  const sameDifficulty = candidates.filter((q) => q.difficulty === current?.difficulty);
  const pick = shuffle(sameDifficulty.length ? sameDifficulty : candidates)[0];
  slot.questionId = pick._id;
  form.markModified(kind);
  await form.save();
  return formSummary(pathId);
}

// Problems that block locking (and so publishing with Pre/Post on).
function formProblems(form, path, stats) {
  const problems = [];
  if (!form) return ["No test yet — generate the Pre and Post."];
  const pathIds = (path.moduleIds || []).map(idStr);
  const formIds = (form.moduleIds || []).map(idStr);
  if (pathIds.join() !== formIds.join()) problems.push("The path's modules changed after this test was generated — generate it again.");
  stats.forEach((m) => {
    if (m.preCount < form.perModule || m.postCount < form.perModule) {
      problems.push(`"${m.title}" needs ${form.perModule * 2} active questions in its bank (has ${m.activeCount}).`);
    }
  });
  const pre = new Set(form.pre.map((s) => idStr(s.questionId)));
  if (form.post.some((s) => pre.has(idStr(s.questionId)))) problems.push("Pre and Post share a question.");
  return problems;
}

async function lockForm(pathId, userId) {
  const path = await Path.findById(pathId).lean();
  if (!path) throw new FormError(404, "Path not found.");
  const form = await currentForm(pathId);
  if (!form) throw new FormError(409, "Generate the test first.");
  if (form.status === "locked") return formSummary(pathId);
  const summary = await formSummary(pathId);
  if (summary.problems.length) throw new FormError(409, summary.problems[0]);
  form.status = "locked";
  form.lockedAt = new Date();
  form.lockedBy = userId || null;
  await form.save();
  return formSummary(pathId);
}

// Everything the admin wizard shows about a Path's test.
async function formSummary(pathId) {
  const path = await Path.findById(pathId).lean();
  if (!path) throw new FormError(404, "Path not found.");
  const form = await currentForm(pathId);
  const active = await activeLockedForm(pathId);
  const modules = await Module.find({ _id: { $in: path.moduleIds } }, "title").lean();
  const titleOf = new Map(modules.map((m) => [idStr(m._id), m.title]));

  const bankCounts = await BankQuestion.aggregate([
    { $match: { moduleId: { $in: path.moduleIds.map((id) => new mongoose.Types.ObjectId(idStr(id))) } } },
    { $group: { _id: { m: "$moduleId", s: "$status", d: "$difficulty" }, n: { $sum: 1 } } },
  ]);
  const coverage = new Map(path.moduleIds.map((id) => [idStr(id), { active: 0, draft: 0, easy: 0, medium: 0, hard: 0 }]));
  bankCounts.forEach(({ _id, n }) => {
    const c = coverage.get(idStr(_id.m));
    if (!c) return;
    if (_id.s === "active") { c.active += n; c[_id.d] += n; }
    if (_id.s === "draft") c.draft += n;
  });

  const qIds = form ? [...form.pre, ...form.post].map((s) => s.questionId) : [];
  const questions = await BankQuestion.find({ _id: { $in: qIds } }).select("+correctIndex +explanation").lean();
  const qMap = new Map(questions.map((q) => [idStr(q._id), q]));
  const detail = (slots) => slots.map((s) => {
    const q = qMap.get(idStr(s.questionId));
    return q ? { ...q, moduleTitle: titleOf.get(idStr(s.moduleId)) || "" } : null;
  }).filter(Boolean);

  const perModule = form ? form.perModule : (path.assessment?.questionsPerModule || 2);
  const moduleStats = path.moduleIds.map((id) => {
    const k = idStr(id);
    const c = coverage.get(k);
    return {
      moduleId: id,
      title: titleOf.get(k) || "(deleted module)",
      activeCount: c.active,
      draftCount: c.draft,
      byDifficulty: { easy: c.easy, medium: c.medium, hard: c.hard },
      needed: perModule * 2,
      preCount: form ? form.pre.filter((s) => idStr(s.moduleId) === k).length : 0,
      postCount: form ? form.post.filter((s) => idStr(s.moduleId) === k).length : 0,
    };
  });

  return {
    pathId: path._id,
    perModule,
    form: form ? {
      _id: form._id, version: form.version, status: form.status, lockedAt: form.lockedAt,
      pre: detail(form.pre), post: detail(form.post),
    } : null,
    activeVersion: active ? active.version : null,
    modules: moduleStats,
    problems: form ? formProblems(form, path, moduleStats) : ["No test yet — generate the Pre and Post."],
  };
}

module.exports = {
  pickForModule,
  generateForm,
  swapQuestion,
  lockForm,
  formSummary,
  currentForm,
  activeLockedForm,
  FormError,
};
