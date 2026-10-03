// src/services/assessments.js
//
// Pre/Post assessments for Paths (Workstream C).
//  • Pre and Post are the Path's fixed, locked test (AssessmentForm), built
//    from the module question bank by services/formGenerator.js — different
//    questions, equally hard. A learner's Post uses the same test VERSION as
//    their Pre. Question order and option order are shuffled per learner;
//    the browser answers with the option's original index.
//  • Pre: available only while it gates the Path (not taken, no baseline yet);
//    one attempt; no XP; the learner is not shown a score or the answers.
//  • Post: available once every module of the Path is complete; one attempt;
//    graded on the server; the learner sees their score, "improved from X% to
//    Y%", and the answers with explanations. XP: 5 per correct answer, via
//    the ledger (one idempotency key per learner per Path).
//  • One attempt per (user, path, kind) — enforced by a unique index, so a
//    double submit can't create two attempts.
const mongoose = require("mongoose");
const Path = require("../models/Path");
const Topic = require("../models/Topic");
const Card = require("../models/Card");
const User = require("../models/User");
const UserTopicProgress = require("../models/UserTopicProgress");
const UserModuleProgress = require("../models/UserModuleProgress");
const UserCardProgress = require("../models/UserCardProgress");
const Module = require("../models/Module");
const BankQuestion = require("../models/BankQuestion");
const AssessmentForm = require("../models/AssessmentForm");
const { activeLockedForm } = require("./formGenerator");
const AssessmentAttempt = require("../models/AssessmentAttempt");
const paths = require("./paths");
const { awardXp, isDuplicateKey } = require("./xpLedger");

const POST_XP_PER_CORRECT = 5;
const KINDS = ["pre", "post"];

class AssessmentError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const userIdOf = (req) => { const u = req.user && req.user.user ? req.user.user : req.user; return u ? (u.id || u._id) : null; };
const pct = (score, max) => (max > 0 ? Math.round((score / max) * 100) : 0);

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// The learner's view of one Path + its assessment state, or a 404.
async function loadLearnerPath(req, pathId) {
  if (!mongoose.Types.ObjectId.isValid(String(pathId || ""))) throw new AssessmentError(400, "Invalid path id.");
  const path = await Path.findById(pathId).lean();
  if (!path || path.status !== "published" || !paths.audienceMatches(path, req)) throw new AssessmentError(404, "Path not found.");
  const [state] = await paths.computePathStates(req, [path]);
  if (!state.totalCount) throw new AssessmentError(404, "Path not found.");
  if (!path.assessment?.enabled) throw new AssessmentError(404, "This path has no Pre/Post check.");
  return { path, state };
}

function availability(kind, state) {
  const a = state.assessment;
  if (kind === "pre") {
    if (a.preDone) return { ok: false, reason: "You've already taken the Pre-check." };
    if (a.noBaseline) return { ok: false, reason: "You'd already started this path, so the Pre-check is skipped." };
    return { ok: true };
  }
  if (a.postDone) return { ok: false, reason: "You've already taken the Post-check." };
  if (!state.allComplete) return { ok: false, reason: "Finish every module in this path to unlock the Post-check." };
  return { ok: true };
}

// Which locked test this learner takes for `kind`: Post reuses the version
// their Pre was taken on; otherwise the newest locked version.
async function formFor(userId, pathId, kind) {
  if (kind === "post") {
    const pre = await AssessmentAttempt.findOne({ user_id: userId, pathId, kind: "pre" }, "formId").lean();
    if (pre?.formId) {
      const same = await AssessmentForm.findById(pre.formId).lean();
      if (same) return same;
    }
  }
  return activeLockedForm(pathId);
}

async function questionsOf(form, kind, withKeys) {
  const slots = form[kind] || [];
  const q = BankQuestion.find({ _id: { $in: slots.map((s) => s.questionId) } });
  const docs = await (withKeys ? q.select("+correctIndex +explanation") : q.select("question options")).lean();
  const byId = new Map(docs.map((d) => [String(d._id), d]));
  return slots.map((s) => {
    const d = byId.get(String(s.questionId));
    return d ? { ...d, moduleId: s.moduleId } : null;
  }).filter(Boolean);
}

// GET: the questions to answer (no answers). Question order and option order
// are shuffled per learner; each option keeps its original index `i`.
async function startAssessment(req, pathId, kind) {
  if (!KINDS.includes(kind)) throw new AssessmentError(400, "Unknown check.");
  const { path, state } = await loadLearnerPath(req, pathId);
  let avail = availability(kind, state);
  const form = avail.ok ? await formFor(userIdOf(req), path._id, kind) : null;
  if (avail.ok && !form) avail = { ok: false, reason: "This check isn't ready yet — please try again later." };
  const questions = form ? await questionsOf(form, kind, false) : [];
  return {
    path: { _id: path._id, name: path.name },
    kind,
    available: avail.ok,
    reason: avail.ok ? null : avail.reason,
    questions: avail.ok
      ? shuffle(questions).map((q) => ({
        _id: q._id,
        question: q.question,
        options: shuffle(q.options.map((text, i) => ({ i, text }))),
      }))
      : [],
  };
}

// POST: grade + store the one attempt.
async function submitAssessment(req, pathId, kind, answers) {
  if (!KINDS.includes(kind)) throw new AssessmentError(400, "Unknown check.");
  const userId = userIdOf(req);
  const { path, state } = await loadLearnerPath(req, pathId);
  const avail = availability(kind, state);
  if (!avail.ok) throw new AssessmentError(409, avail.reason);

  const form = await formFor(userId, path._id, kind);
  if (!form) throw new AssessmentError(409, "This check isn't ready yet — please try again later.");
  const questions = await questionsOf(form, kind, true);
  if (!questions.length) throw new AssessmentError(409, "This check has no questions yet.");

  const chosen = new Map();
  (Array.isArray(answers) ? answers : []).forEach((a) => {
    if (a && mongoose.Types.ObjectId.isValid(String(a.questionId || ""))) {
      const n = Number(a.selectedOption);
      chosen.set(String(a.questionId), Number.isInteger(n) ? n : null);
    }
  });

  const graded = questions.map((q) => {
    const selectedOption = chosen.has(String(q._id)) ? chosen.get(String(q._id)) : null;
    return {
      questionId: q._id,
      moduleId: q.moduleId || null,
      selectedOption,
      isCorrect: selectedOption !== null && selectedOption === q.correctIndex,
    };
  });
  const score = graded.filter((g) => g.isCorrect).length;
  const maxScore = questions.length;

  let attempt;
  try {
    attempt = await AssessmentAttempt.create({
      user_id: userId, pathId: path._id, kind, formId: form._id, formVersion: form.version,
      answers: graded, score, maxScore, percent: pct(score, maxScore),
    });
  } catch (err) {
    if (isDuplicateKey(err)) throw new AssessmentError(409, `You've already taken the ${kind === "pre" ? "Pre" : "Post"}-check.`);
    throw err;
  }

  // Per-question stats in the bank (how often answered / answered right).
  await BankQuestion.bulkWrite(graded.map((g) => ({
    updateOne: { filter: { _id: g.questionId }, update: { $inc: { "stats.answered": 1, "stats.correct": g.isCorrect ? 1 : 0 } } },
  })));

  if (kind === "pre") {
    // Pre never reveals answers or a score, and never awards XP.
    return { kind, submitted: true };
  }

  let xpChange = 0;
  if (score > 0) {
    const award = await awardXp({
      userId, amount: score * POST_XP_PER_CORRECT, source: "assessment",
      idempotencyKey: `post:${userId}:${path._id}`, sourceId: path._id,
    });
    xpChange = award.amount;
    if (xpChange) await AssessmentAttempt.updateOne({ _id: attempt._id }, { $set: { xpAwarded: xpChange } });
  }
  return { ...(await buildResult(userId, path)), xpChange };
}

// The learner's own result: Pre stays private (only its percent is used for
// the improvement line once Post exists); Post includes a full review.
async function buildResult(userId, path) {
  const [pre, post] = await Promise.all([
    AssessmentAttempt.findOne({ user_id: userId, pathId: path._id, kind: "pre" }).lean(),
    AssessmentAttempt.findOne({ user_id: userId, pathId: path._id, kind: "post" }).lean(),
  ]);
  const out = { kind: "post", path: { _id: path._id, name: path.name }, preDone: !!pre, postDone: !!post };
  if (!post) return out;
  const form = post.formId ? await AssessmentForm.findById(post.formId).lean() : null;
  const questions = form ? await questionsOf(form, "post", true) : [];
  const byId = new Map(post.answers.map((a) => [String(a.questionId), a]));
  return {
    ...out,
    score: post.score,
    maxScore: post.maxScore,
    percent: post.percent,
    prePercent: pre ? pre.percent : null,
    improvement: pre ? post.percent - pre.percent : null,
    review: questions.map((q) => {
      const a = byId.get(String(q._id));
      return {
        questionId: q._id,
        question: q.question,
        options: q.options,
        selectedOption: a ? a.selectedOption : null,
        correctIndex: q.correctIndex,
        explanation: q.explanation || "",
        isCorrect: !!a?.isCorrect,
      };
    }),
  };
}

async function learnerResult(req, pathId) {
  const { path } = await loadLearnerPath(req, pathId);
  return buildResult(userIdOf(req), path);
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

// Which of `moduleIds` each user has completed — same rule as
// utils/moduleLock.computeModuleCompletionMap, batched across many users.
async function completionByUser(moduleIds, userIds) {
  const mods = await Module.find({ _id: { $in: moduleIds } }, "hasTopics engineStrategy").lean();
  const isFlat = (m) => m.engineStrategy === "EXPRESS_FLAT" || m.hasTopics === false;
  const flatIds = mods.filter(isFlat).map((m) => m._id);
  const stdIds = mods.filter((m) => !isFlat(m)).map((m) => m._id);
  const done = new Map(userIds.map((u) => [String(u), new Set()]));
  const always = new Set();

  if (flatIds.length) {
    const [cardTotals, prog] = await Promise.all([
      Card.aggregate([{ $match: { module_id: { $in: flatIds } } }, { $group: { _id: "$module_id", n: { $sum: 1 } } }]),
      UserModuleProgress.find({ user_id: { $in: userIds }, module_id: { $in: flatIds }, isCompleted: true }, "user_id module_id").lean(),
    ]);
    const hasCards = new Set(cardTotals.map((c) => String(c._id)));
    flatIds.forEach((id) => { if (!hasCards.has(String(id))) always.add(String(id)); });
    prog.forEach((p) => done.get(String(p.user_id))?.add(String(p.module_id)));
  }
  if (stdIds.length) {
    const [topicTotals, prog] = await Promise.all([
      Topic.aggregate([{ $match: { module_id: { $in: stdIds } } }, { $group: { _id: "$module_id", n: { $sum: 1 } } }]),
      UserTopicProgress.aggregate([
        { $match: { user_id: { $in: userIds }, module_id: { $in: stdIds }, isCompleted: true } },
        { $group: { _id: { u: "$user_id", m: "$module_id" }, n: { $sum: 1 } } },
      ]),
    ]);
    const totals = new Map(topicTotals.map((t) => [String(t._id), t.n]));
    stdIds.forEach((id) => { if (!totals.get(String(id))) always.add(String(id)); });
    prog.forEach((p) => {
      if (p.n >= (totals.get(String(p._id.m)) || 0)) done.get(String(p._id.u))?.add(String(p._id.m));
    });
  }
  always.forEach((id) => done.forEach((set) => set.add(id)));
  return done;
}

const avg = (nums) => (nums.length ? Math.round(nums.reduce((s, n) => s + n, 0) / nums.length) : null);

// One Path's numbers for a set of users.
async function pathReport(path, userIds) {
  const moduleIds = (path.moduleIds || []).map((id) => new mongoose.Types.ObjectId(String(id)));
  const [attempts, touched, completion] = await Promise.all([
    AssessmentAttempt.find({ pathId: path._id, user_id: { $in: userIds } }, "user_id kind percent answers").lean(),
    // aggregate, not distinct (Stable API strict mode — see config/db.js).
    moduleIds.length
      ? UserCardProgress.aggregate([
        { $match: { user_id: { $in: userIds.map((u) => new mongoose.Types.ObjectId(String(u))) }, module_id: { $in: moduleIds }, isArchived: { $ne: true } } },
        { $group: { _id: "$user_id" } },
      ])
      : [],
    completionByUser(moduleIds, userIds),
  ]);
  const pre = new Map(); const post = new Map();
  attempts.forEach((a) => (a.kind === "pre" ? pre : post).set(String(a.user_id), a.percent));
  const touchedSet = new Set(touched.map((t) => String(t._id)));

  const learners = userIds.map((uid) => {
    const id = String(uid);
    const completed = completion.get(id)?.size || 0;
    const started = touchedSet.has(id) || pre.has(id) || post.has(id);
    return {
      userId: id,
      prePercent: pre.has(id) ? pre.get(id) : null,
      postPercent: post.has(id) ? post.get(id) : null,
      improvement: pre.has(id) && post.has(id) ? post.get(id) - pre.get(id) : null,
      modulesCompleted: Math.min(completed, moduleIds.length),
      modulesTotal: moduleIds.length,
      started,
      noBaseline: started && !pre.has(id) && touchedSet.has(id),
    };
  }).filter((l) => l.started);

  const paired = learners.filter((l) => l.improvement !== null);

  // Per module and per question, from the answers themselves.
  const moduleAgg = new Map();
  const questionAgg = new Map();
  attempts.forEach((a) => (a.answers || []).forEach((ans) => {
    const mk = String(ans.moduleId || "");
    const m = moduleAgg.get(mk) || { pre: { n: 0, c: 0 }, post: { n: 0, c: 0 } };
    m[a.kind].n += 1; if (ans.isCorrect) m[a.kind].c += 1;
    moduleAgg.set(mk, m);
    const qk = `${a.kind}:${ans.questionId}`;
    const q = questionAgg.get(qk) || { kind: a.kind, questionId: ans.questionId, moduleId: ans.moduleId, n: 0, c: 0 };
    q.n += 1; if (ans.isCorrect) q.c += 1;
    questionAgg.set(qk, q);
  }));
  const [modDocs, qDocs] = await Promise.all([
    Module.find({ _id: { $in: moduleIds } }, "title").lean(),
    BankQuestion.find({ _id: { $in: [...questionAgg.values()].map((q) => q.questionId) } }, "question difficulty").lean(),
  ]);
  const modTitle = new Map(modDocs.map((m) => [String(m._id), m.title]));
  const qText = new Map(qDocs.map((q) => [String(q._id), q]));
  const byModule = moduleIds.map((id) => {
    const m = moduleAgg.get(String(id)) || { pre: { n: 0, c: 0 }, post: { n: 0, c: 0 } };
    return {
      moduleId: id,
      title: modTitle.get(String(id)) || "",
      prePercent: m.pre.n ? pct(m.pre.c, m.pre.n) : null,
      postPercent: m.post.n ? pct(m.post.c, m.post.n) : null,
    };
  });
  const byQuestion = [...questionAgg.values()].map((q) => ({
    kind: q.kind,
    questionId: q.questionId,
    question: qText.get(String(q.questionId))?.question || "",
    difficulty: qText.get(String(q.questionId))?.difficulty || "",
    module: modTitle.get(String(q.moduleId)) || "",
    answered: q.n,
    correctPercent: pct(q.c, q.n),
  })).sort((a, b) => a.kind.localeCompare(b.kind) || a.correctPercent - b.correctPercent);

  return {
    learners,
    byModule,
    byQuestion,
    summary: {
      started: learners.length,
      preDone: pre.size,
      postDone: post.size,
      completedPath: learners.filter((l) => l.modulesTotal > 0 && l.modulesCompleted >= l.modulesTotal).length,
      preAvg: avg([...pre.values()]),
      postAvg: avg([...post.values()]),
      improvementAvg: avg(paired.map((l) => l.improvement)),
      pairedCount: paired.length,
      noBaseline: learners.filter((l) => l.noBaseline).length,
    },
  };
}

async function attachUsers(learners) {
  const users = await User.find({ _id: { $in: learners.map((l) => l.userId) } }, "username email department team")
    .populate("department", "name").populate("team", "name").lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));
  return learners.map((l) => {
    const u = byId.get(l.userId) || {};
    return { ...l, username: u.username || "", email: u.email || "", department: u.department?.name || "", team: u.team?.name || "" };
  });
}

module.exports = {
  startAssessment,
  submitAssessment,
  learnerResult,
  pathReport,
  attachUsers,
  completionByUser,
  AssessmentError,
  POST_XP_PER_CORRECT,
};
