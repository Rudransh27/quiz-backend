// tests/assessments.http.test.js
//
// Question bank → generated fixed Pre/Post test → learner Pre/Post, end to end
// through the real routers (Workstream C, bank edition).
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const { connect, closeDatabase, clearCollections } = require('./setup/inMemoryMongo');
const { makeUser, makeDepartment } = require('./setup/fixtures');
const User = require('../src/models/User');
const Card = require('../src/models/Card');
const Module = require('../src/models/Module');
const Category = require('../src/models/Category');
const Path = require('../src/models/Path');
const BankQuestion = require('../src/models/BankQuestion');
const AssessmentForm = require('../src/models/AssessmentForm');
const AssessmentAttempt = require('../src/models/AssessmentAttempt');
const XpTransaction = require('../src/models/XpTransaction');
const UserCardProgress = require('../src/models/UserCardProgress');
const AssessmentReset = require('../src/models/AssessmentReset');
const { invalidatePathsEnabled } = require('../src/services/paths');

jest.setTimeout(60000);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret-do-not-use-in-prod';

let app;
function authed(req, user) {
  const bindingSecret = crypto.randomBytes(32).toString('hex');
  const bh = crypto.createHash('sha256').update(bindingSecret).digest('hex');
  const token = jwt.sign({ user: { id: user._id.toString(), role: user.role, bh, sessionId: crypto.randomUUID() } }, process.env.JWT_SECRET, { expiresIn: '1h' });
  return req.set('Authorization', `Bearer ${token}`).set('Cookie', `orbit_bind=${bindingSecret}`);
}
const get = (u, url) => authed(request(app).get(url), u);
const post = (u, url, body) => authed(request(app).post(url), u).send(body || {});

beforeAll(async () => {
  await connect();
  app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/learn', require('../src/routes/learnRoutes'));
  app.use('/api/paths', require('../src/routes/pathRoutes'));
  app.use('/api/assessments', require('../src/routes/assessmentRoutes'));
  app.use('/api/grading', require('../src/routes/gradingRoutes'));
  await Promise.all([Card, Path, AssessmentAttempt, AssessmentForm, XpTransaction, UserCardProgress].map((m) => m.init()));
});
afterAll(closeDatabase);

let dept; let learner; let admin; let otherLearner; let path; let mods; let cards;

// 4 bank questions per module (2 easy, 2 medium); option 0 is always correct.
async function seedBank(moduleList, perDifficulty = { easy: 2, medium: 2 }) {
  const docs = [];
  moduleList.forEach((m) => Object.entries(perDifficulty).forEach(([difficulty, n]) => {
    for (let i = 0; i < n; i++) {
      docs.push({ moduleId: m._id, question: `${m.title} ${difficulty} ${i}`, options: ['right', 'wrong', 'also wrong'], correctIndex: 0, explanation: `because ${m.title}`, difficulty });
    }
  }));
  return BankQuestion.insertMany(docs);
}

async function lockTest(pathDoc) {
  const gen = await post(admin, `/api/paths/${pathDoc._id}/form/generate`, { perModule: 2 });
  expect(gen.status).toBe(200);
  const lock = await post(admin, `/api/paths/${pathDoc._id}/form/lock`);
  expect(lock.status).toBe(200);
  return lock.body.data;
}

beforeEach(async () => {
  await clearCollections();
  await Promise.all([Card, Path, AssessmentAttempt, AssessmentForm, XpTransaction, UserCardProgress].map((m) => m.syncIndexes()));
  invalidatePathsEnabled();
  dept = await makeDepartment();
  learner = await makeUser({ department: dept });
  otherLearner = await makeUser({ department: await makeDepartment() });
  admin = await makeUser({ department: dept, role: 'admin' });
  const tag = await Category.create({ name: 'FR', visibility: 'Global' });
  mods = await Promise.all([1, 2].map((i) => Module.create({ title: `M${i}`, visibility: 'Global', categoryId: tag._id, engineStrategy: 'EXPRESS_FLAT', hasTopics: false })));
  cards = await Promise.all(mods.map((m) => Card.create({ module_id: m._id, card_type: 'quiz', cardOrder: 1, content: { options: ['a', 'b'], correctIndex: 0 } })));
  path = await Path.create({ categoryId: tag._id, name: 'FR Path', moduleIds: mods.map((m) => m._id), status: 'draft', assessment: { enabled: true, questionsPerModule: 2 } });
  await seedBank(mods);
  await lockTest(path);
  await post(admin, `/api/paths/${path._id}/publish`, { published: true });
  invalidatePathsEnabled();
});

// Answer a served check: `right` of the questions correctly (original option 0).
async function take(user, kind, right) {
  const start = await get(user, `/api/assessments/paths/${path._id}/${kind}`);
  expect(start.body.data.available).toBe(true);
  const answers = start.body.data.questions.map((q, i) => ({ questionId: q._id, selectedOption: i < right ? 0 : 1 }));
  return { start, res: await post(user, `/api/assessments/paths/${path._id}/${kind}`, { answers }) };
}
const finishModules = async () => {
  for (const c of cards) {
    const r = await post(learner, `/api/grading/cards/${c._id}/attempt`, { answer: { selectedOption: 0 } });
    expect(r.status).toBe(200);
  }
};

test('Pre: served without answers, options shuffled with original indices; private baseline, no XP', async () => {
  const { start, res } = await take(learner, 'pre', 2);
  const qs = start.body.data.questions;
  expect(qs).toHaveLength(4); // 2 modules × 2 per module
  expect(JSON.stringify(start.body)).not.toMatch(/correctIndex|explanation|because/);
  qs.forEach((q) => expect(q.options.map((o) => o.i).sort()).toEqual([0, 1, 2]));
  expect(res.status).toBe(201);
  expect(res.body.data).toEqual({ kind: 'pre', submitted: true });
  expect((await User.findById(learner._id).lean()).xp).toBe(0);
  expect(await AssessmentAttempt.findOne({ kind: 'pre' }).lean()).toMatchObject({ score: 2, maxScore: 4, percent: 50, formVersion: 1 });
  expect((await post(learner, `/api/assessments/paths/${path._id}/pre`, { answers: [] })).status).toBe(409);
});

test('Pre and Post are different questions covering every module equally', async () => {
  const form = await AssessmentForm.findOne({ pathId: path._id }).lean();
  const pre = form.pre.map((s) => String(s.questionId));
  const post = form.post.map((s) => String(s.questionId));
  expect(pre).toHaveLength(4);
  expect(post).toHaveLength(4);
  expect(pre.filter((id) => post.includes(id))).toEqual([]);
  mods.forEach((m) => {
    expect(form.pre.filter((s) => String(s.moduleId) === String(m._id))).toHaveLength(2);
    expect(form.post.filter((s) => String(s.moduleId) === String(m._id))).toHaveLength(2);
  });
});

test('Post: locked until modules are done; graded with improvement, review, XP and bank stats', async () => {
  await take(learner, 'pre', 1);
  expect((await get(learner, `/api/assessments/paths/${path._id}/post`)).body.data.available).toBe(false);
  await finishModules();
  const { res } = await take(learner, 'post', 3);
  expect(res.status).toBe(201);
  expect(res.body.data).toMatchObject({ percent: 75, prePercent: 25, improvement: 50, score: 3, maxScore: 4, xpChange: 15 });
  expect(res.body.data.review).toHaveLength(4);
  expect(res.body.data.review[0]).toHaveProperty('correctIndex', 0);
  const answered = await BankQuestion.aggregate([{ $group: { _id: null, a: { $sum: '$stats.answered' }, c: { $sum: '$stats.correct' } } }]);
  expect(answered[0]).toMatchObject({ a: 8, c: 4 });
});

test('a learner\'s Post uses the same test version as their Pre, even after a new version is locked', async () => {
  const { start: preStart } = await take(learner, 'pre', 2);
  // Admin adds questions and locks version 2.
  await seedBank(mods, { hard: 2 });
  await lockTest(path);
  expect(await AssessmentForm.countDocuments({ pathId: path._id, status: 'locked' })).toBe(2);
  await finishModules();
  const v1 = await AssessmentForm.findOne({ pathId: path._id, version: 1 }).lean();
  const postStart = await get(learner, `/api/assessments/paths/${path._id}/post`);
  expect(postStart.body.data.questions.map((q) => q._id).sort()).toEqual(v1.post.map((s) => String(s.questionId)).sort());
  expect(preStart.body.data.questions.map((q) => q._id).sort()).toEqual(v1.pre.map((s) => String(s.questionId)).sort());
  // A new learner starts on version 2.
  const newcomer = await makeUser({ department: dept });
  await post(newcomer, `/api/assessments/paths/${path._id}/pre`, { answers: [] });
  expect(await AssessmentAttempt.findOne({ user_id: newcomer._id }).lean()).toMatchObject({ formVersion: 2 });
});

test('a double-submitted Post creates one attempt and one XP award', async () => {
  await take(learner, 'pre', 1);
  await finishModules();
  const start = await get(learner, `/api/assessments/paths/${path._id}/post`);
  const answers = start.body.data.questions.map((q) => ({ questionId: q._id, selectedOption: 0 }));
  const res = await Promise.all([1, 2, 3].map(() => post(learner, `/api/assessments/paths/${path._id}/post`, { answers })));
  expect(res.filter((r) => r.status === 201)).toHaveLength(1);
  expect(await AssessmentAttempt.countDocuments({ kind: 'post' })).toBe(1);
  expect(await XpTransaction.countDocuments({ source: 'assessment' })).toBe(1);
});

test('answers for questions outside the served test are ignored (scored wrong)', async () => {
  const foreign = await BankQuestion.create({ moduleId: mods[0]._id, question: 'not in the test', options: ['a', 'b'], correctIndex: 0 });
  await post(learner, `/api/assessments/paths/${path._id}/pre`, { answers: [{ questionId: foreign._id, selectedOption: 0 }] });
  expect(await AssessmentAttempt.findOne({ kind: 'pre' }).lean()).toMatchObject({ score: 0, maxScore: 4 });
});

test('no-baseline learners skip Pre and can still take Post', async () => {
  await UserCardProgress.create({ user_id: learner._id, card_id: cards[0]._id, module_id: mods[0]._id, isCorrect: true });
  const pre = await get(learner, `/api/assessments/paths/${path._id}/pre`);
  expect(pre.body.data.available).toBe(false);
  expect(pre.body.data.reason).toMatch(/skipped/);
  await finishModules();
  const { res } = await take(learner, 'post', 4);
  expect(res.body.data).toMatchObject({ percent: 100, prePercent: null, improvement: null });
});

test('admin report: averages, per learner, per module and per question; department-scoped', async () => {
  await take(learner, 'pre', 2);
  await finishModules();
  await take(learner, 'post', 4);
  await post(otherLearner, `/api/assessments/paths/${path._id}/pre`, { answers: [] });

  const report = await get(admin, '/api/assessments/admin/report');
  expect(report.body.data[0]).toMatchObject({ path: 'FR Path', started: 1, preDone: 1, postDone: 1, preAvg: 50, postAvg: 100, improvementAvg: 50 });

  const detail = await get(admin, `/api/assessments/admin/report/paths/${path._id}`);
  expect(detail.body.data).toHaveLength(1);
  expect(detail.body.data[0]).toMatchObject({ prePercent: 50, postPercent: 100, improvement: 50, status: 'Complete' });
  expect(detail.body.byModule.map((m) => m.title)).toEqual(['M1', 'M2']);
  detail.body.byModule.forEach((m) => expect(m.postPercent).toBe(100));
  expect(detail.body.byQuestion.filter((q) => q.kind === 'post')).toHaveLength(4);
  expect(detail.body.byQuestion.filter((q) => q.kind === 'pre')).toHaveLength(4);

  const csv = await get(admin, '/api/assessments/admin/report?format=csv');
  expect(csv.text.split('\r\n')[1]).toMatch(/^FR,FR Path,published,2,1,1,1,1,50,100,50,1,0$/);
});

// ---------------- admin reset ----------------
const resetUrl = (u = learner) => `/api/assessments/admin/paths/${path._id}/users/${u._id}/reset`;

test('admin reset of a Post: attempt removed and logged, learner retakes it, no second XP award', async () => {
  await take(learner, 'pre', 1);
  await finishModules();
  await take(learner, 'post', 2);
  const xpBefore = (await User.findById(learner._id).lean()).xp;

  const res = await post(admin, resetUrl(), { kind: 'post', reason: 'Submitted by mistake' });
  expect(res.status).toBe(200);
  expect(await AssessmentAttempt.countDocuments({ kind: 'post' })).toBe(0);
  expect(await AssessmentReset.findOne().lean()).toMatchObject({
    kind: 'post', status: 'pending', reason: 'Submitted by mistake',
    previous: { score: 2, maxScore: 4, percent: 50, formVersion: 1, xpAwarded: 10 },
  });
  const detail = await get(admin, `/api/assessments/admin/report/paths/${path._id}`);
  expect(detail.body.data[0]).toMatchObject({ postPercent: null, postResetPending: true });

  const { res: retake } = await take(learner, 'post', 4);
  expect(retake.status).toBe(201);
  expect(retake.body.data).toMatchObject({ percent: 100, prePercent: 25, improvement: 75, xpChange: 0 });
  expect((await User.findById(learner._id).lean()).xp).toBe(xpBefore);
  expect(await XpTransaction.countDocuments({ source: 'assessment' })).toBe(1);
  expect(await AssessmentReset.findOne().lean()).toMatchObject({ status: 'retaken' });
});

test('a Pre can only be reset once the Post is reset', async () => {
  await take(learner, 'pre', 1);
  await finishModules();
  await take(learner, 'post', 2);
  const res = await post(admin, resetUrl(), { kind: 'pre' });
  expect(res.status).toBe(409);
  expect(res.body.message).toMatch(/Post-check first/);
  expect(await AssessmentAttempt.countDocuments()).toBe(2);
  expect(await AssessmentReset.countDocuments()).toBe(0);
});

test('a reset Pre is asked for again even after the learner started modules, and gates the path', async () => {
  await take(learner, 'pre', 1);
  await post(learner, `/api/grading/cards/${cards[0]._id}/attempt`, { answer: { selectedOption: 0 } });
  expect((await post(admin, resetUrl(), { kind: 'pre' })).status).toBe(200);

  const pre = await get(learner, `/api/assessments/paths/${path._id}/pre`);
  expect(pre.body.data.available).toBe(true); // not "skipped (no baseline)"
  const blocked = await post(learner, `/api/grading/cards/${cards[1]._id}/attempt`, { answer: { selectedOption: 0 } });
  expect(blocked.status).toBe(403);

  await take(learner, 'pre', 3);
  expect(await AssessmentAttempt.findOne({ kind: 'pre' }).lean()).toMatchObject({ score: 3 });
  expect(await AssessmentReset.findOne().lean()).toMatchObject({ kind: 'pre', status: 'retaken', previous: { score: 1 } });
  expect((await post(learner, `/api/grading/cards/${cards[1]._id}/attempt`, { answer: { selectedOption: 0 } })).status).toBe(200);
});

test('reset: nothing to reset, bad kind, learner outside the admin department', async () => {
  expect((await post(admin, resetUrl(), { kind: 'post' })).status).toBe(404);
  await take(learner, 'pre', 1);
  expect((await post(admin, resetUrl(), { kind: 'everything' })).status).toBe(400);
  await post(otherLearner, `/api/assessments/paths/${path._id}/pre`, { answers: [] });
  expect((await post(admin, resetUrl(otherLearner), { kind: 'pre' })).status).toBe(403);
  expect((await post(learner, resetUrl(), { kind: 'pre' })).status).toBe(403);
  expect(await AssessmentAttempt.countDocuments()).toBe(2);
});

test('switching the check off keeps its results in the report', async () => {
  await take(learner, 'pre', 2);
  await Path.updateOne({ _id: path._id }, { $set: { 'assessment.enabled': false } });
  const report = await get(admin, '/api/assessments/admin/report');
  expect(report.body.data).toHaveLength(1);
  expect(report.body.data[0]).toMatchObject({ path: 'FR Path', preDone: 1, assessmentEnabled: false });
});
