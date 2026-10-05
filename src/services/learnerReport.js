// src/services/learnerReport.js
//
// Admin reports about individual learners: a roster (one row per learner),
// one learner's full report (paths with Pre/Post, every module they can see
// or have touched, totals), and one module's question-by-question results.
//
// "In-module score" = share of auto-graded questions (quiz, code and the
// auto-graded questions inside HTML modules) the learner got RIGHT FIRST
// TIME. Retries are allowed for learning, so the latest answer is nearly
// always right and says little; the first answer shows what they knew.
//  • First answers come from GradeAttempt (earliest generation, earliest
//    attempt — module resets don't wipe the original first try).
//  • Answers saved before server-side grading (a UserCardProgress doc without
//    gradeGeneration) have no reliable first try. For those the recorded
//    (final) answer is used and counted as `recorded`, so the UI can say so.
//    A legacy quiz/code card answered exactly once is a genuine first try.
//  • Written (descriptive) answers are graded by an admin and reported
//    separately — never mixed into the auto-graded score.
const mongoose = require("mongoose");
const User = require("../models/User");
const Department = require("../models/Department");
const Team = require("../models/Team");
const Region = require("../models/Region");
const Card = require("../models/Card");
const Topic = require("../models/Topic");
const Module = require("../models/Module");
const Category = require("../models/Category");
const Path = require("../models/Path");
const GradeAttempt = require("../models/GradeAttempt");
const UserCardProgress = require("../models/UserCardProgress");
const UserModuleProgress = require("../models/UserModuleProgress");
const UserTopicProgress = require("../models/UserTopicProgress");
const ModuleResetLog = require("../models/ModuleResetLog");
const AssessmentAttempt = require("../models/AssessmentAttempt");
const AssessmentReset = require("../models/AssessmentReset");
const paths = require("./paths");
const { completionByUser } = require("./assessments");
const { correctAnswerText } = require("./grading/graders");

const GRADED_TYPES = ["quiz", "code", "html_sandbox"];
const LOW_SCORE = 60; // below this an in-module score is flagged "needs attention"

class ReportError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const isId = (v) => /^[a-f0-9]{24}$/i.test(String(v || ""));
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const str = (v) => (v && v._id ? String(v._id) : v ? String(v) : "");
const pct = (c, n) => (n > 0 ? Math.round((c / n) * 100) : null);
const maxDate = (...ds) => ds.filter(Boolean).reduce((a, b) => (!a || b > a ? b : a), null);
const emptyScore = () => ({ answered: 0, correct: 0, firstTry: 0, recorded: 0 });
const emptyWritten = () => ({ questions: 0, pending: 0, graded: 0, score: 0, max: 0 });
const finishScore = (s) => ({ ...s, percent: pct(s.correct, s.answered) });
const logQuestions = (logs) => (Array.isArray(logs) ? logs : logs?.questions || []);
const isWritten = (q) => q?.type === "descriptive" || q?.type === "text";

// Department / team / region names for a set of users. Looked up by hand
// rather than populate(): older users may hold a legacy department string.
async function nameLookup(users) {
  const ids = (field) => [...new Set(users.flatMap((u) => [].concat(u[field] || [])).map(str).filter(isId))];
  const [depts, teams, regions] = await Promise.all([
    Department.find({ _id: { $in: ids("department") } }, "name").lean(),
    Team.find({ _id: { $in: ids("team") } }, "name").lean(),
    Region.find({ _id: { $in: ids("regions") } }, "name").lean(),
  ]);
  const by = (list) => new Map(list.map((d) => [String(d._id), d.name]));
  const [d, t, r] = [by(depts), by(teams), by(regions)];
  return {
    department: (u) => d.get(str(u.department)) || "",
    team: (u) => t.get(str(u.team)) || "",
    regions: (u) => (u.regions || []).map((x) => r.get(str(x))).filter(Boolean),
  };
}

// A department admin may report on learners in their own department only.
function canViewLearner(req, user) {
  if (req.user.role === "superadmin") return true;
  return !!req.user.department && !!user.department && str(user.department) === str(req.user.department);
}

// The learner as a request context, so the same visibility / audience / lock
// rules the learner gets (services/paths) decide what's "theirs".
const learnerContext = (u) => ({
  user: {
    id: u._id,
    role: u.role,
    department: u.department || null,
    team: u.team || null,
    regions: u.regions || [],
  },
});

async function loadLearner(req, userId) {
  if (!isId(userId)) throw new ReportError(400, "Invalid learner id.");
  const user = await User.findById(userId, "username email role xp department team regions createdAt lastLoginAt lastLoginMethod lastLoginProvider").lean();
  if (!user) throw new ReportError(404, "Learner not found.");
  if (!canViewLearner(req, user)) throw new ReportError(403, "This learner is outside your department.");
  return user;
}

// ---------------------------------------------------------------------------
// Cards, modules and per-question results
// ---------------------------------------------------------------------------

// Quiz / code / HTML cards with the module (and topic) they belong to.
async function gradableCards(moduleIds = null) {
  const topics = await Topic.find(moduleIds ? { module_id: { $in: moduleIds } } : {}, "module_id title topicOrder").lean();
  const topicById = new Map(topics.map((t) => [String(t._id), t]));
  const filter = { card_type: { $in: GRADED_TYPES } };
  if (moduleIds) filter.$or = [{ module_id: { $in: moduleIds } }, { topic_id: { $in: topics.map((t) => t._id) } }];
  const cards = await Card.find(filter)
    .select("card_type module_id topic_id cardOrder content.title content.question content.options content.correctIndex +answerKey")
    .lean();
  return cards
    .map((c) => {
      const topic = c.topic_id ? topicById.get(String(c.topic_id)) : null;
      return { ...c, moduleId: str(c.module_id || topic?.module_id), topic };
    })
    .filter((c) => c.moduleId);
}

// Number of cards (any type) per module — the denominator for "progress".
async function cardTotalsByModule(moduleIds) {
  const ids = moduleIds.map(oid);
  const topics = await Topic.find({ module_id: { $in: ids } }, "module_id").lean();
  const topicModule = new Map(topics.map((t) => [String(t._id), String(t.module_id)]));
  const rows = await Card.aggregate([
    { $match: { $or: [{ module_id: { $in: ids } }, { topic_id: { $in: topics.map((t) => t._id) } }] } },
    { $group: { _id: { m: "$module_id", t: "$topic_id" }, n: { $sum: 1 } } },
  ]);
  const totals = new Map();
  rows.forEach((r) => {
    const m = r._id.m ? String(r._id.m) : topicModule.get(String(r._id.t));
    if (m) totals.set(m, (totals.get(m) || 0) + r.n);
  });
  return totals;
}

// Every (learner, card, question) result for these learners and cards.
// `onQuestion(row)` gets one call per auto-graded question the learner
// answered; `onWritten(row)` one per card with written answers.
async function walkResults(userIds, cards, { onQuestion, onWritten, fullLogs = false }) {
  if (!userIds.length || !cards.length) return;
  const uids = userIds.map(oid);
  const cardIds = cards.map((c) => c._id);
  const logFields = fullLogs
    ? "metaFeedbackLogs"
    : "metaFeedbackLogs.questions.id metaFeedbackLogs.questions.type metaFeedbackLogs.questions.isCorrect metaFeedbackLogs.questions.maxPoints metaFeedbackLogs.adminScore";
  const [attempts, progress] = await Promise.all([
    GradeAttempt.aggregate([
      { $match: { user_id: { $in: uids }, card_id: { $in: cardIds }, kind: { $in: ["card", "sandbox_answer"] } } },
      { $sort: { attemptGeneration: 1, createdAt: 1 } },
      {
        $group: {
          _id: { u: "$user_id", c: "$card_id", q: "$questionId" },
          first: { $first: "$isCorrect" },
          firstAnswer: { $first: "$answer" },
          last: { $last: "$isCorrect" },
          tries: { $sum: 1 },
          lastAt: { $max: "$createdAt" },
        },
      },
    ]),
    UserCardProgress.find(
      { user_id: { $in: uids }, card_id: { $in: cardIds } },
      `user_id card_id isCorrect isArchived timesAttempted gradeGeneration selectedOption createdAt updatedAt ${logFields}`,
    ).lean(),
  ]);

  const gaBy = new Map(attempts.map((a) => [`${a._id.u}:${a._id.c}:${a._id.q}`, a]));
  const ucpBy = new Map();
  progress.forEach((p) => {
    const k = `${p.user_id}:${p.card_id}`;
    const e = ucpBy.get(k) || { active: null, legacy: null, times: 0, lastAt: null };
    if (!p.isArchived) e.active = p;
    if (p.gradeGeneration === undefined || p.gradeGeneration === null) {
      if (!e.legacy || p.createdAt < e.legacy.createdAt) e.legacy = p;
    }
    e.times += p.timesAttempted || 0;
    e.lastAt = maxDate(e.lastAt, p.updatedAt);
    ucpBy.set(k, e);
  });

  for (const uid of userIds.map(String)) {
    for (const card of cards) {
      const cid = String(card._id);
      const ucp = ucpBy.get(`${uid}:${cid}`);
      const base = { userId: uid, card, moduleId: card.moduleId };

      if (card.card_type !== "html_sandbox") {
        const ga = gaBy.get(`${uid}:${cid}:`);
        if (!ga && !ucp) continue;
        const first = ucp?.legacy
          ? (ucp.legacy.timesAttempted === 1 ? !!ucp.legacy.isCorrect : null)
          : (typeof ga?.first === "boolean" ? ga.first : null);
        const latest = ucp?.active ? !!ucp.active.isCorrect : (typeof ga?.last === "boolean" ? ga.last : null);
        onQuestion({
          ...base, questionId: "", first, latest,
          tries: Math.max(ga?.tries || 0, ucp?.times || 0),
          lastAt: maxDate(ga?.lastAt, ucp?.lastAt),
          firstAnswer: ga?.firstAnswer, ucp: ucp?.active || null,
        });
        continue;
      }

      // HTML module: one result per auto-graded question in its answer key.
      const keyQs = card.answerKey?.questions || [];
      const logs = ucp?.active ? logQuestions(ucp.active.metaFeedbackLogs) : [];
      const logById = new Map(logs.filter((q) => q && q.id).map((q) => [String(q.id), q]));
      const legacy = !!ucp?.legacy;
      const written = emptyWritten();
      for (const kq of keyQs) {
        const log = logById.get(String(kq.id));
        if (isWritten(kq)) {
          if (log) { written.questions += 1; written.max += kq.points || log.maxPoints || 0; }
          continue;
        }
        const ga = gaBy.get(`${uid}:${cid}:${kq.id}`);
        const latest = typeof log?.isCorrect === "boolean" ? log.isCorrect : (typeof ga?.last === "boolean" ? ga.last : null);
        if (!ga && latest === null) continue;
        onQuestion({
          ...base, questionId: String(kq.id), keyQuestion: kq, log,
          first: legacy ? null : (typeof ga?.first === "boolean" ? ga.first : null),
          latest,
          tries: ga?.tries || (log ? 1 : 0),
          lastAt: maxDate(ga?.lastAt, ucp?.lastAt),
          firstAnswer: ga?.firstAnswer,
        });
      }
      if (written.questions && onWritten) {
        const adminScore = ucp.active?.metaFeedbackLogs?.adminScore;
        const graded = typeof adminScore === "number";
        onWritten({
          ...base,
          written: { ...written, pending: graded ? 0 : written.questions, graded: graded ? written.questions : 0, score: graded ? adminScore : 0 },
          feedback: ucp.active?.metaFeedbackLogs?.adminFeedback || "",
          logs,
        });
      }
    }
  }
}

// Adds one question result to a score bucket.
function tally(score, q) {
  const result = q.first !== null ? q.first : q.latest;
  if (result === null) return;
  score.answered += 1;
  if (result) score.correct += 1;
  if (q.first !== null) score.firstTry += 1; else score.recorded += 1;
}
function tallyWritten(w, row) {
  w.questions += row.written.questions;
  w.pending += row.written.pending;
  w.graded += row.written.graded;
  w.score += row.written.score;
  w.max += row.written.max;
}

// Per (learner, module): score, written answers, last answer time.
async function inModuleResults(userIds, cards) {
  const out = new Map(); // `${userId}:${moduleId}` → { score, written, lastAt }
  const bucket = (u, m) => {
    const k = `${u}:${m}`;
    if (!out.has(k)) out.set(k, { score: emptyScore(), written: emptyWritten(), lastAt: null });
    return out.get(k);
  };
  await walkResults(userIds, cards, {
    onQuestion: (q) => { const b = bucket(q.userId, q.moduleId); tally(b.score, q); b.lastAt = maxDate(b.lastAt, q.lastAt); },
    onWritten: (w) => tallyWritten(bucket(w.userId, w.moduleId).written, w),
  });
  return out;
}

// Per (learner, module): cards done, time spent, last activity.
async function activityByModule(userIds) {
  const uids = userIds.map(oid);
  const [cardsDone, flatTime, topicTime] = await Promise.all([
    UserCardProgress.aggregate([
      { $match: { user_id: { $in: uids }, isArchived: { $ne: true } } },
      { $group: { _id: { u: "$user_id", m: "$module_id" }, n: { $sum: 1 }, lastAt: { $max: "$updatedAt" } } },
    ]),
    UserModuleProgress.find({ user_id: { $in: uids } }, "user_id module_id timeSpentSeconds resetCount updatedAt").lean(),
    UserTopicProgress.aggregate([
      { $match: { user_id: { $in: uids } } },
      { $group: { _id: { u: "$user_id", m: "$module_id" }, t: { $sum: "$timeSpentSeconds" }, lastAt: { $max: "$updatedAt" } } },
    ]),
  ]);
  const out = new Map();
  const at = (u, m) => {
    const k = `${u}:${m}`;
    if (!out.has(k)) out.set(k, { cardsDone: 0, timeSeconds: 0, lastAt: null });
    return out.get(k);
  };
  cardsDone.forEach((r) => { if (r._id.m) { const a = at(r._id.u, r._id.m); a.cardsDone = r.n; a.lastAt = maxDate(a.lastAt, r.lastAt); } });
  flatTime.forEach((r) => { const a = at(r.user_id, r.module_id); a.timeSeconds += r.timeSpentSeconds || 0; });
  topicTime.forEach((r) => { if (r._id.m) { const a = at(r._id.u, r._id.m); a.timeSeconds += r.t || 0; a.lastAt = maxDate(a.lastAt, r.lastAt); } });
  return out;
}

// ---------------------------------------------------------------------------
// One learner
// ---------------------------------------------------------------------------

function moduleStatus(completed, activity, score) {
  if (completed) return "completed";
  if ((activity?.cardsDone || 0) > 0 || (score?.answered || 0) > 0) return "in_progress";
  return "not_started";
}

async function learnerReport(req, userId) {
  const user = await loadLearner(req, userId);
  const uid = String(user._id);
  const ctx = learnerContext(user);

  // Paths: every published Path the learner is in the audience for, plus
  // any Path they have a Pre/Post attempt or reset on (even if unpublished
  // or its check was later switched off — history stays visible).
  const [attempts, resets] = await Promise.all([
    AssessmentAttempt.find({ user_id: user._id }, "pathId kind score maxScore percent xpAwarded formVersion createdAt").lean(),
    AssessmentReset.find({ user_id: user._id }).sort({ createdAt: -1 }).populate("resetBy", "username").lean(),
  ]);
  const published = (await Path.find({ status: "published" }).sort({ order: 1, createdAt: 1 }).lean())
    .filter((p) => paths.audienceMatches(p, ctx));
  const seen = new Set(published.map((p) => String(p._id)));
  const extraIds = [...new Set([...attempts, ...resets].map((a) => String(a.pathId)))].filter((id) => !seen.has(id));
  const extra = extraIds.length ? await Path.find({ _id: { $in: extraIds } }).lean() : [];
  const states = await paths.computePathStates(ctx, [...published, ...extra]);

  // Modules: everything in those paths the learner can see + anything touched.
  const activity = await activityByModule([uid]);
  const touchedIds = [...activity.keys()].map((k) => k.split(":")[1]);
  const gaModules = await GradeAttempt.aggregate([{ $match: { user_id: user._id } }, { $group: { _id: "$module_id" } }]);
  const moduleIds = [...new Set([
    ...states.flatMap((s) => s.modules.map((m) => String(m.module._id))),
    ...touchedIds,
    ...gaModules.map((g) => String(g._id)),
  ])].filter(isId);

  const [modules, cards, totals, resetLogs] = await Promise.all([
    Module.find({ _id: { $in: moduleIds } }, "title categoryId moduleType").lean(),
    gradableCards(moduleIds.map(oid)),
    cardTotalsByModule(moduleIds),
    ModuleResetLog.aggregate([{ $match: { user_id: user._id } }, { $group: { _id: "$module_id", n: { $sum: 1 } } }]),
  ]);
  const withContent = moduleIds.filter((id) => (totals.get(id) || 0) > 0);
  const [results, completion, tags] = await Promise.all([
    inModuleResults([uid], cards),
    completionByUser(withContent.map(oid), [user._id]),
    Category.find({ _id: { $in: modules.map((m) => m.categoryId).filter(Boolean) } }, "name").lean(),
  ]);
  // Completed per the report's rule, or per the learner's own path view
  // (which also counts a module with no cards as done).
  const done = new Set(completion.get(uid) || []);
  states.forEach((s) => s.modules.forEach((m) => { if (m.completed) done.add(String(m.module._id)); }));
  const tagName = new Map(tags.map((t) => [String(t._id), t.name]));
  const resetCount = new Map(resetLogs.map((r) => [String(r._id), r.n]));
  const pathNames = new Map();
  states.forEach((s) => s.modules.forEach((m) => {
    const k = String(m.module._id);
    pathNames.set(k, [...(pathNames.get(k) || []), s.path.name]);
  }));

  const moduleRows = modules.map((m) => {
    const id = String(m._id);
    const act = activity.get(`${uid}:${id}`);
    const res = results.get(`${uid}:${id}`);
    const total = totals.get(id) || 0;
    const cardsDone = Math.min(act?.cardsDone || 0, total);
    // Every card done also counts (older progress can lack the completion flag).
    const completed = done.has(id) || (total > 0 && cardsDone >= total);
    return {
      moduleId: id,
      title: m.title,
      tag: tagName.get(String(m.categoryId)) || "",
      paths: pathNames.get(id) || [],
      status: moduleStatus(completed, act, res?.score),
      progress: { done: completed ? total : cardsDone, total, percent: completed ? 100 : pct(cardsDone, total) || 0 },
      score: finishScore(res?.score || emptyScore()),
      written: res?.written || emptyWritten(),
      timeSeconds: act?.timeSeconds || 0,
      lastActive: maxDate(act?.lastAt, res?.lastAt),
      resets: resetCount.get(id) || 0,
    };
  });
  const order = { in_progress: 0, completed: 1, not_started: 2 };
  moduleRows.sort((a, b) => order[a.status] - order[b.status]
    || (b.lastActive ? +new Date(b.lastActive) : 0) - (a.lastActive ? +new Date(a.lastActive) : 0)
    || a.title.localeCompare(b.title));
  const moduleById = new Map(moduleRows.map((r) => [r.moduleId, r]));

  const attemptBy = new Map(attempts.map((a) => [`${a.pathId}:${a.kind}`, a]));
  const pendingReset = new Set(resets.filter((r) => r.status === "pending").map((r) => `${r.pathId}:${r.kind}`));
  const pathTags = await Category.find({ _id: { $in: states.map((s) => s.path.categoryId).filter(Boolean) } }, "name").lean();
  const pathTagName = new Map(pathTags.map((t) => [String(t._id), t.name]));
  const attemptView = (a) => (a ? { percent: a.percent, score: a.score, maxScore: a.maxScore, takenAt: a.createdAt, xpAwarded: a.xpAwarded || 0 } : null);

  const pathRows = states
    .map((s) => {
      const pid = String(s.path._id);
      const pre = attemptBy.get(`${pid}:pre`) || null;
      const post = attemptBy.get(`${pid}:post`) || null;
      const a = s.assessment;
      const rows = s.modules.map((m) => moduleById.get(String(m.module._id))).filter(Boolean);
      const inModule = emptyScore();
      rows.forEach((r) => { inModule.answered += r.score.answered; inModule.correct += r.score.correct; inModule.firstTry += r.score.firstTry; inModule.recorded += r.score.recorded; });
      const started = rows.some((r) => r.status !== "not_started") || !!pre || !!post;
      const preState = pre ? "done" : pendingReset.has(`${pid}:pre`) ? "reset" : !a.enabled ? "off" : a.noBaseline ? "skipped" : "due";
      const postState = post ? "done" : pendingReset.has(`${pid}:post`) ? "reset" : !a.enabled ? "off" : a.postUnlocked ? "open" : "locked";
      let status = "Not started";
      if (started) status = "In progress";
      if (s.allComplete) status = a.enabled && !post ? "Post-check due" : "Complete";
      const inModuleScore = finishScore(inModule);
      return {
        pathId: pid,
        name: s.path.name,
        tag: pathTagName.get(String(s.path.categoryId)) || "",
        published: s.path.status === "published",
        assessmentEnabled: !!a.enabled,
        modulesCompleted: s.completedCount,
        modulesTotal: s.totalCount,
        pre: attemptView(pre),
        post: attemptView(post),
        preState,
        postState,
        improvement: pre && post ? post.percent - pre.percent : null,
        inModule: inModuleScore,
        // The path's outcome: the Post-check when there is one, otherwise the
        // in-module score of its modules (clearly labelled as such).
        outcome: post
          ? { percent: post.percent, source: "post" }
          : inModuleScore.answered ? { percent: inModuleScore.percent, source: "in_module" } : null,
        status,
        started,
        canReset: { pre: !!pre && !post, post: !!post },
      };
    })
    .filter((p) => p.modulesTotal > 0 || p.pre || p.post || p.preState === "reset" || p.postState === "reset");
  pathRows.sort((a, b) => Number(b.started) - Number(a.started) || a.name.localeCompare(b.name));

  const score = emptyScore();
  const written = emptyWritten();
  moduleRows.forEach((r) => {
    score.answered += r.score.answered; score.correct += r.score.correct; score.firstTry += r.score.firstTry; score.recorded += r.score.recorded;
    written.questions += r.written.questions; written.pending += r.written.pending; written.graded += r.written.graded; written.score += r.written.score; written.max += r.written.max;
  });
  const paired = pathRows.filter((p) => p.improvement !== null);
  const names = await nameLookup([user]);

  return {
    user: {
      _id: uid,
      username: user.username,
      email: user.email,
      role: user.role,
      department: names.department(user),
      team: names.team(user),
      regions: names.regions(user),
      joinedAt: user.createdAt,
      xp: user.xp || 0,
      lastLoginAt: user.lastLoginAt || null,
      lastLoginMethod: user.lastLoginMethod || null,
    },
    summary: {
      modulesCompleted: moduleRows.filter((r) => r.status === "completed").length,
      modulesStarted: moduleRows.filter((r) => r.status !== "not_started").length,
      modulesTotal: moduleRows.length,
      score: finishScore(score),
      written,
      timeSeconds: moduleRows.reduce((s, r) => s + r.timeSeconds, 0),
      lastActive: maxDate(...moduleRows.map((r) => r.lastActive), ...attempts.map((a) => a.createdAt)),
      checksPaired: paired.length,
      avgImprovement: paired.length ? Math.round(paired.reduce((s, p) => s + p.improvement, 0) / paired.length) : null,
      needsAttention: moduleRows.filter((r) => r.score.percent !== null && r.score.percent < LOW_SCORE).length,
      lowScore: LOW_SCORE,
    },
    paths: pathRows,
    modules: moduleRows,
    resets: resets.map((r) => ({
      _id: r._id,
      pathId: r.pathId,
      path: states.find((s) => String(s.path._id) === String(r.pathId))?.path.name || "",
      kind: r.kind,
      resetBy: r.resetBy?.username || "",
      reason: r.reason,
      previous: r.previous,
      status: r.status,
      createdAt: r.createdAt,
      retakenAt: r.retakenAt,
    })),
  };
}

// ---------------------------------------------------------------------------
// One learner × one module, question by question
// ---------------------------------------------------------------------------

const clip = (v, n = 400) => {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

async function learnerModuleDetail(req, userId, moduleId) {
  const user = await loadLearner(req, userId);
  if (!isId(moduleId)) throw new ReportError(400, "Invalid module id.");
  const mod = await Module.findById(moduleId, "title").lean();
  if (!mod) throw new ReportError(404, "Module not found.");
  const cards = await gradableCards([oid(moduleId)]);
  cards.sort((a, b) => (a.topic?.topicOrder ?? 0) - (b.topic?.topicOrder ?? 0) || (a.cardOrder ?? 0) - (b.cardOrder ?? 0));

  const byCard = new Map(cards.map((c) => [String(c._id), { questions: [], written: null }]));
  await walkResults([String(user._id)], cards, {
    fullLogs: true,
    onQuestion: (q) => {
      const c = q.card;
      let text = ""; let answer = ""; let correct = "";
      if (c.card_type === "quiz") {
        const opts = c.content?.options || [];
        text = c.content?.question || "";
        const sel = q.ucp && Number.isInteger(q.ucp.selectedOption) ? q.ucp.selectedOption : q.firstAnswer?.selectedOption;
        answer = Number.isInteger(sel) ? opts[sel] ?? "" : "";
        const ci = c.answerKey?.correctIndex ?? c.content?.correctIndex;
        correct = Number.isInteger(ci) ? opts[ci] ?? "" : "";
      } else if (c.card_type === "code") {
        text = c.content?.question || c.content?.title || "";
      } else {
        text = q.keyQuestion?.questionText || q.log?.questionText || q.questionId;
        answer = clip(q.log?.userAnswer ?? q.firstAnswer);
        correct = q.log?.correctAnswer || correctAnswerText(q.keyQuestion || {}) || "";
      }
      byCard.get(String(c._id)).questions.push({
        id: q.questionId || String(c._id),
        text: clip(text, 600),
        first: q.first,
        latest: q.latest,
        basis: q.first !== null ? "first" : "recorded",
        tries: q.tries,
        answer: clip(answer),
        correct: clip(correct),
        lastAt: q.lastAt,
      });
    },
    onWritten: (w) => {
      byCard.get(String(w.card._id)).written = {
        ...w.written,
        feedback: w.feedback,
        answers: w.logs.filter((l) => isWritten(l) || l.isCorrect === null || l.isCorrect === undefined)
          .map((l) => ({ id: String(l.id), text: clip(l.questionText, 600), answer: clip(l.userAnswer, 2000) })),
      };
    },
  });

  const score = emptyScore();
  const out = cards.map((c) => {
    const entry = byCard.get(String(c._id));
    entry.questions.forEach((q) => tally(score, q));
    return {
      cardId: String(c._id),
      title: c.content?.title || (c.card_type === "quiz" ? "Quiz" : c.card_type === "code" ? "Code task" : "Interactive module"),
      topic: c.topic?.title || "",
      type: c.card_type,
      questions: entry.questions,
      written: entry.written,
    };
  }).filter((c) => c.questions.length || c.written);

  return {
    module: { _id: String(mod._id), title: mod.title },
    score: finishScore(score),
    cards: out,
    unanswered: cards.length - out.length,
  };
}

// ---------------------------------------------------------------------------
// Roster: one row per learner in the admin's scope
// ---------------------------------------------------------------------------

async function learnerRoster(userIds) {
  if (!userIds.length) return [];
  const uids = userIds.map(oid);
  const users = await User.find({ _id: { $in: uids } }, "username email role xp department team regions").lean();
  const ids = users.map((u) => String(u._id));
  const names = await nameLookup(users);

  const cards = await gradableCards();
  const allModules = await Module.find({}, "_id").lean();
  const totals = await cardTotalsByModule(allModules.map((m) => String(m._id)));
  const withContent = [...totals.keys()].filter((id) => totals.get(id) > 0).map(oid);
  const [results, activity, completion, checks, lastGa] = await Promise.all([
    inModuleResults(ids, cards),
    activityByModule(ids),
    completionByUser(withContent, uids),
    AssessmentAttempt.aggregate([
      { $match: { user_id: { $in: uids } } },
      { $group: { _id: { u: "$user_id", k: "$kind" }, avg: { $avg: "$percent" }, n: { $sum: 1 }, lastAt: { $max: "$createdAt" } } },
    ]),
    GradeAttempt.aggregate([{ $match: { user_id: { $in: uids } } }, { $group: { _id: "$user_id", lastAt: { $max: "$createdAt" } } }]),
  ]);

  const per = new Map(ids.map((id) => [id, { score: emptyScore(), written: emptyWritten(), started: new Set(), timeSeconds: 0, lastAt: null }]));
  results.forEach((r, k) => {
    const [u, m] = k.split(":");
    const p = per.get(u); if (!p) return;
    p.score.answered += r.score.answered; p.score.correct += r.score.correct; p.score.firstTry += r.score.firstTry; p.score.recorded += r.score.recorded;
    p.written.pending += r.written.pending;
    if (r.score.answered) p.started.add(m);
    p.lastAt = maxDate(p.lastAt, r.lastAt);
  });
  activity.forEach((a, k) => {
    const [u, m] = k.split(":");
    const p = per.get(u); if (!p) return;
    if (a.cardsDone) p.started.add(m);
    p.timeSeconds += a.timeSeconds;
    p.lastAt = maxDate(p.lastAt, a.lastAt);
  });
  const checkBy = new Map(checks.map((c) => [`${c._id.u}:${c._id.k}`, c]));
  checks.forEach((c) => { const p = per.get(String(c._id.u)); if (p) p.lastAt = maxDate(p.lastAt, c.lastAt); });
  lastGa.forEach((g) => { const p = per.get(String(g._id)); if (p) p.lastAt = maxDate(p.lastAt, g.lastAt); });

  return users.map((u) => {
    const id = String(u._id);
    const p = per.get(id);
    const pre = checkBy.get(`${id}:pre`);
    const post = checkBy.get(`${id}:post`);
    const score = finishScore(p.score);
    const completed = completion.get(id)?.size || 0;
    return {
      userId: id,
      username: u.username,
      email: u.email,
      role: u.role,
      department: names.department(u),
      team: names.team(u),
      regions: names.regions(u),
      xp: u.xp || 0,
      modulesCompleted: completed,
      modulesStarted: Math.max(p.started.size, completed),
      score,
      writtenPending: p.written.pending,
      preAvg: pre ? Math.round(pre.avg) : null,
      postAvg: post ? Math.round(post.avg) : null,
      checksTaken: (pre?.n || 0) + (post?.n || 0),
      timeSeconds: p.timeSeconds,
      lastActive: p.lastAt,
      needsAttention: score.percent !== null && score.percent < LOW_SCORE,
    };
  }).sort((a, b) => (b.lastActive ? +new Date(b.lastActive) : 0) - (a.lastActive ? +new Date(a.lastActive) : 0) || a.username.localeCompare(b.username));
}

module.exports = {
  learnerReport,
  learnerModuleDetail,
  learnerRoster,
  loadLearner,
  canViewLearner,
  ReportError,
  LOW_SCORE,
};
