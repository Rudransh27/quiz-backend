// tests/learnerReport.http.test.js
//
// Admin learner reports (routes/reportRoutes.js): first-try in-module score,
// older answers, HTML modules with written answers, Pre/Post per path, the
// department-scoped roster and access rules.
const fs = require('fs');
const nodePath = require('path');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const { connect, closeDatabase, clearCollections } = require('./setup/inMemoryMongo');
const { makeUser, makeDepartment } = require('./setup/fixtures');
const Card = require('../src/models/Card');
const Module = require('../src/models/Module');
const Category = require('../src/models/Category');
const Path = require('../src/models/Path');
const AssessmentAttempt = require('../src/models/AssessmentAttempt');
const UserCardProgress = require('../src/models/UserCardProgress');
const GradeAttempt = require('../src/models/GradeAttempt');
const XpTransaction = require('../src/models/XpTransaction');
const { invalidatePathsEnabled } = require('../src/services/paths');

jest.setTimeout(60000);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret-do-not-use-in-prod';

const CARBON_NITI = '6a567442bd99e9e44689e1bb'; // 5 MCQ + 4 descriptive
const nitiHtml = fs.readFileSync(nodePath.join(__dirname, 'fixtures', 'sandbox', `${CARBON_NITI}.html`), 'utf8');

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
  app.use('/api/grading', require('../src/routes/gradingRoutes'));
  app.use('/api/reports', require('../src/routes/reportRoutes'));
});
afterAll(closeDatabase);

let dept; let learner; let admin; let outsiderAdmin; let outsider; let superadmin;
let m1; let m3; let quizA; let quizB; let niti; let p1; let p2;

beforeEach(async () => {
  await clearCollections();
  await Promise.all([Card, Path, AssessmentAttempt, UserCardProgress, GradeAttempt, XpTransaction].map((m) => m.syncIndexes()));
  invalidatePathsEnabled();
  dept = await makeDepartment();
  const otherDept = await makeDepartment();
  learner = await makeUser({ department: dept, username: 'Priya' });
  admin = await makeUser({ department: dept, role: 'admin' });
  outsider = await makeUser({ department: otherDept });
  outsiderAdmin = await makeUser({ department: otherDept, role: 'admin' });
  superadmin = await makeUser({ department: otherDept, role: 'superadmin' });

  const tag = await Category.create({ name: 'FR', visibility: 'Global' });
  const base = { visibility: 'Global', categoryId: tag._id, engineStrategy: 'EXPRESS_FLAT', hasTopics: false };
  m1 = await Module.create({ ...base, title: 'Intro to XBRL' });
  m3 = await Module.create({ ...base, title: 'Carbon NITI', moduleType: 'html_sandbox' });
  quizA = await Card.create({ module_id: m1._id, card_type: 'quiz', cardOrder: 1, content: { question: 'What is XBRL?', options: ['A language', 'A database'], correctIndex: 0 } });
  quizB = await Card.create({ module_id: m1._id, card_type: 'quiz', cardOrder: 2, content: { question: 'Who files?', options: ['Companies', 'Nobody'], correctIndex: 0 } });
  niti = await Card.create({ module_id: m3._id, card_type: 'html_sandbox', cardOrder: 1, content: { title: 'Niti', htmlSource: nitiHtml } });

  p1 = await Path.create({ categoryId: tag._id, name: 'Foundations', moduleIds: [m1._id], status: 'published', sequentialUnlock: false });
  p2 = await Path.create({ categoryId: tag._id, name: 'Carbon', moduleIds: [m3._id], status: 'published', assessment: { enabled: true } });
  invalidatePathsEnabled();
});

const answerQuiz = (card, selectedOption) => post(learner, `/api/grading/cards/${card._id}/attempt`, { answer: { selectedOption } });
const moduleRow = (body, title) => body.data.modules.find((m) => m.title === title);

test('in-module score counts the first answer, not the retry', async () => {
  await answerQuiz(quizA, 1); // wrong first
  await answerQuiz(quizA, 0); // retry, right
  await answerQuiz(quizB, 0);

  const res = await get(admin, `/api/reports/learners/${learner._id}`);
  expect(res.status).toBe(200);
  expect(moduleRow(res.body, 'Intro to XBRL')).toMatchObject({
    status: 'completed',
    progress: { done: 2, total: 2, percent: 100 },
    score: { answered: 2, correct: 1, firstTry: 2, recorded: 0, percent: 50 },
  });
  expect(moduleRow(res.body, 'Carbon NITI')).toMatchObject({ status: 'not_started', score: { answered: 0, percent: null } });
  expect(res.body.data.summary).toMatchObject({ modulesCompleted: 1, modulesStarted: 1, score: { percent: 50 } });

  const detail = await get(admin, `/api/reports/learners/${learner._id}/modules/${m1._id}`);
  expect(detail.status).toBe(200);
  const [a, b] = detail.body.data.cards.map((c) => c.questions[0]);
  expect(a).toMatchObject({ text: 'What is XBRL?', first: false, latest: true, tries: 2, basis: 'first', answer: 'A language', correct: 'A language' });
  expect(b).toMatchObject({ first: true, latest: true, tries: 1 });
});

test('answers saved before first-try tracking: one try is a real first try, otherwise the recorded answer is used', async () => {
  await UserCardProgress.create({ user_id: learner._id, card_id: quizA._id, module_id: m1._id, isCorrect: false, timesAttempted: 1 });
  await UserCardProgress.create({ user_id: learner._id, card_id: quizB._id, module_id: m1._id, isCorrect: true, timesAttempted: 3 });
  const res = await get(admin, `/api/reports/learners/${learner._id}`);
  expect(moduleRow(res.body, 'Intro to XBRL').score).toEqual({ answered: 2, correct: 1, firstTry: 1, recorded: 1, percent: 50 });
  const detail = await get(admin, `/api/reports/learners/${learner._id}/modules/${m1._id}`);
  expect(detail.body.data.cards.map((c) => c.questions[0].basis)).toEqual(['first', 'recorded']);
});

test('HTML module: auto-graded questions scored, written answers reported separately as awaiting grading', async () => {
  await AssessmentAttempt.create({ user_id: learner._id, pathId: p2._id, kind: 'pre', score: 1, maxScore: 2, percent: 50 });
  const { answerKey } = await Card.findById(niti._id).select('+answerKey').lean();
  const right = (q) => q.options[q.optionKeys.indexOf(q.correctKey)];
  const questions = answerKey.questions.map((q, i) => ({
    id: q.id,
    type: q.type === 'mcq' ? 'mcq' : 'text',
    userAnswer: q.type === 'mcq' ? (i === 0 ? 'zzz' : right(q)) : `essay ${i}`,
  }));
  expect((await post(learner, `/api/grading/cards/${niti._id}/sandbox-submit`, { questions })).status).toBe(200);

  const res = await get(admin, `/api/reports/learners/${learner._id}`);
  const row = moduleRow(res.body, 'Carbon NITI');
  expect(row.score).toMatchObject({ answered: 5, correct: 4, firstTry: 5, percent: 80 });
  expect(row.written).toMatchObject({ questions: 4, pending: 4, graded: 0 });

  const detail = await get(admin, `/api/reports/learners/${learner._id}/modules/${m3._id}`);
  const card = detail.body.data.cards[0];
  expect(card.questions).toHaveLength(5);
  expect(card.questions[0]).toMatchObject({ first: false, answer: 'zzz' });
  expect(card.written.answers.map((w) => w.answer)).toEqual(['essay 5', 'essay 6', 'essay 7', 'essay 8']);
});

test('paths: Pre/Post with improvement; in-module outcome where there is no Post-check', async () => {
  await answerQuiz(quizA, 0);
  await answerQuiz(quizB, 1);
  await AssessmentAttempt.create({ user_id: learner._id, pathId: p2._id, kind: 'pre', score: 2, maxScore: 5, percent: 40 });
  await AssessmentAttempt.create({ user_id: learner._id, pathId: p2._id, kind: 'post', score: 4, maxScore: 5, percent: 80 });

  const res = await get(admin, `/api/reports/learners/${learner._id}`);
  const byName = Object.fromEntries(res.body.data.paths.map((p) => [p.name, p]));
  expect(byName.Foundations).toMatchObject({
    assessmentEnabled: false, preState: 'off', status: 'Complete',
    inModule: { percent: 50 }, outcome: { percent: 50, source: 'in_module' },
  });
  expect(byName.Carbon).toMatchObject({
    pre: { percent: 40 }, post: { percent: 80 }, improvement: 40,
    outcome: { percent: 80, source: 'post' }, canReset: { pre: false, post: true },
  });
  expect(res.body.data.summary).toMatchObject({ checksPaired: 1, avgImprovement: 40 });

  const csv = await get(admin, `/api/reports/learners/${learner._id}?format=csv`);
  expect(csv.status).toBe(200);
  expect(csv.text).toMatch(/^Type,Name,Status,Progress,In-module score %/);
  expect(csv.text).toMatch(/Path,Carbon,.*,40,80,40,80 \(Post-check\)/);
});

test('roster: department-scoped for admins, everyone for a superadmin, CSV export', async () => {
  await answerQuiz(quizA, 1);
  const res = await get(admin, '/api/reports/learners');
  expect(res.status).toBe(200);
  const ids = res.body.data.map((r) => r.userId);
  expect(ids).toContain(String(learner._id));
  expect(ids).not.toContain(String(outsider._id));
  expect(res.body.data.find((r) => r.userId === String(learner._id))).toMatchObject({
    username: 'Priya', modulesStarted: 1, score: { answered: 1, correct: 0, percent: 0 }, needsAttention: true,
  });

  const all = await get(superadmin, '/api/reports/learners');
  expect(all.body.data.map((r) => r.userId)).toEqual(expect.arrayContaining([String(learner._id), String(outsider._id)]));

  const csv = await get(admin, '/api/reports/learners?format=csv');
  expect(csv.text.split('\r\n')[0]).toMatch(/^Name,Email,Department,Team,Regions,Modules completed/);
});

test('access: other department admins, learners and bad ids are refused', async () => {
  expect((await get(outsiderAdmin, `/api/reports/learners/${learner._id}`)).status).toBe(403);
  expect((await get(outsiderAdmin, `/api/reports/learners/${learner._id}/modules/${m1._id}`)).status).toBe(403);
  expect((await get(learner, `/api/reports/learners/${learner._id}`)).status).toBe(403);
  expect((await get(learner, '/api/reports/learners')).status).toBe(403);
  expect((await get(admin, '/api/reports/learners/not-an-id')).status).toBe(400);
  expect((await get(superadmin, `/api/reports/learners/${learner._id}`)).status).toBe(200);
});
