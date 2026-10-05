// tests/grading.http.test.js
//
// End-to-end server-side grading through the REAL routers (grading,
// progress, modules, topics) and the REAL auth middleware, against an
// in-memory MongoDB. Covers the launch acceptance criteria:
//   • forged isCorrect / forged sandbox score earns 0 XP
//   • 10 parallel identical submissions → exactly one XP award
//   • submitting under another module can't bypass the sequential lock
//   • no learner-facing response leaks an answer key
//   • first-answer rule, retries earn 0, reset re-enables a first attempt
//   • manual-grade regrade writes the correct delta
const fs = require('fs');
const path = require('path');
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
const UserCardProgress = require('../src/models/UserCardProgress');
const XpTransaction = require('../src/models/XpTransaction');
const GradeAttempt = require('../src/models/GradeAttempt');
const UserCardGeneration = require('../src/models/UserCardGeneration');

jest.setTimeout(60000);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret-do-not-use-in-prod';

const fixtureHtml = (id) => fs.readFileSync(path.join(__dirname, 'fixtures', 'sandbox', `${id}.html`), 'utf8');
const BEYOND_THE_MANDATE = '6a67284faa7c79ed1b4319ba'; // Family A: ansM + fill-blank + in-module retry
const CARBON_NITI = '6a567442bd99e9e44689e1bb';         // Family B: const Q, 5 MCQ + 4 descriptive

let app;

function authed(req, user) {
  const bindingSecret = crypto.randomBytes(32).toString('hex');
  const bh = crypto.createHash('sha256').update(bindingSecret).digest('hex');
  const token = jwt.sign({ user: { id: user._id.toString(), role: user.role, bh, sessionId: crypto.randomUUID() } }, process.env.JWT_SECRET, { expiresIn: '1h' });
  return req.set('Authorization', `Bearer ${token}`).set('Cookie', `orbit_bind=${bindingSecret}`);
}

const xpOf = async (user) => (await User.findById(user._id, 'xp').lean()).xp;

beforeAll(async () => {
  await connect();
  app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use(cookieParser());
  app.use('/api/grading', require('../src/routes/gradingRoutes'));
  app.use('/api/progress', require('../src/routes/progressRoutes'));
  app.use('/api/modules', require('../src/routes/moduleRoutes'));
  app.use('/api/topics', require('../src/routes/topicRoutes'));
  await Promise.all([Card, XpTransaction, GradeAttempt, UserCardGeneration, UserCardProgress].map((m) => m.init()));
});

afterAll(closeDatabase);

let learner; let superadmin; let dept;
let category; let modA; let modB; let quizA; let quizA2; let knowledgeB; let quizB;
let sandboxMod; let sandboxCard; let famBMod; let famBCard;

beforeEach(async () => {
  await clearCollections();
  await Promise.all([Card, XpTransaction, GradeAttempt, UserCardGeneration, UserCardProgress].map((m) => m.syncIndexes()));
  dept = await makeDepartment();
  learner = await makeUser({ department: dept });
  superadmin = await makeUser({ department: dept, role: 'superadmin' });

  category = await Category.create({ name: 'Financial Reporting', sequentialUnlock: true, visibility: 'Global' });
  const base = { visibility: 'Global', categoryId: category._id, engineStrategy: 'EXPRESS_FLAT', hasTopics: false };
  modA = await Module.create({ ...base, title: 'Module A', order: 0 });
  modB = await Module.create({ ...base, title: 'Module B', order: 1 });
  quizA = await Card.create({ module_id: modA._id, card_type: 'quiz', cardOrder: 1, content: { question: 'Q?', options: ['w', 'RIGHT', 'x', 'y'], correctIndex: 1, explanation: 'Because.' } });
  quizA2 = await Card.create({ module_id: modA._id, card_type: 'quiz', cardOrder: 2, content: { text: JSON.stringify({ options: ['a', 'b', 'c'], correctAnswerIndex: 2, explanationHint: 'hint-secret' }) } });
  knowledgeB = await Card.create({ module_id: modB._id, card_type: 'knowledge', cardOrder: 1, content: { text: 'read me' } });
  quizB = await Card.create({ module_id: modB._id, card_type: 'quiz', cardOrder: 2, content: { question: 'B?', options: ['a', 'b'], correctIndex: 0 } });

  const open = await Category.create({ name: 'Open', sequentialUnlock: false, visibility: 'Global' });
  const sandboxBase = { visibility: 'Global', categoryId: open._id, engineStrategy: 'EXPRESS_FLAT', hasTopics: false, moduleType: 'html_sandbox' };
  sandboxMod = await Module.create({ ...sandboxBase, title: 'Beyond the Mandate', order: 0 });
  sandboxCard = await Card.create({ module_id: sandboxMod._id, card_type: 'html_sandbox', cardOrder: 1, content: { title: 'BtM', htmlSource: fixtureHtml(BEYOND_THE_MANDATE) } });
  famBMod = await Module.create({ ...sandboxBase, title: 'Carbon NITI', order: 1 });
  famBCard = await Card.create({ module_id: famBMod._id, card_type: 'html_sandbox', cardOrder: 1, content: { title: 'Niti', htmlSource: fixtureHtml(CARBON_NITI) } });
});

const attempt = (user, card, body) => authed(request(app).post(`/api/grading/cards/${card._id}/attempt`), user).send(body);

describe('quiz / code attempts', () => {
  test('answer key is stored select:false and derived from content', async () => {
    expect((await Card.findById(quizA._id).lean()).answerKey).toBeUndefined();
    const withKey = await Card.findById(quizA2._id).select('+answerKey').lean();
    expect(withKey.answerKey).toEqual({ correctIndex: 2, explanation: 'hint-secret' });
  });

  test('a client-supplied answerKey is ignored on update', async () => {
    await Card.findByIdAndUpdate(quizA._id, { answerKey: { correctIndex: 3 } });
    expect((await Card.findById(quizA._id).select('+answerKey').lean()).answerKey.correctIndex).toBe(1);
  });

  test('forged isCorrect on the legacy endpoint is rejected and earns 0 XP', async () => {
    const res = await authed(request(app).post('/api/progress/card-completed'), learner)
      .send({ cardId: quizA._id, moduleId: modA._id, isCorrect: true, answeredScore: 999 });
    expect(res.status).toBe(400);
    expect(await xpOf(learner)).toBe(0);
    expect(await UserCardProgress.countDocuments({})).toBe(0);
  });

  test('server decides correctness; key revealed only in the graded response', async () => {
    const res = await attempt(learner, quizA, { answer: { selectedOption: 1 }, isCorrect: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ isCorrect: true, xpChange: 5, firstAttempt: true, correctIndex: 1, explanation: 'Because.' });
    expect(await xpOf(learner)).toBe(5);
  });

  test('first answer rule: wrong first, right on retry → 0 XP, status from the latest attempt', async () => {
    const wrong = await attempt(learner, quizA, { answer: { selectedOption: 0 } });
    expect(wrong.body).toMatchObject({ isCorrect: false, xpChange: 0, firstAttempt: true });
    const right = await attempt(learner, quizA, { answer: { selectedOption: 1 } });
    expect(right.body).toMatchObject({ isCorrect: true, xpChange: 0, firstAttempt: false });
    expect(await xpOf(learner)).toBe(0);
    const p = await UserCardProgress.findOne({ card_id: quizA._id }).lean();
    expect(p).toMatchObject({ isCorrect: true, selectedOption: 1, timesAttempted: 2, xpAwarded: 0, gradeGeneration: 0 });
    expect(await GradeAttempt.countDocuments({ card_id: quizA._id })).toBe(2);
  });

  test('10 parallel identical submissions → exactly one XP award', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => attempt(learner, quizA, { answer: { selectedOption: 1 } })));
    results.forEach((r) => expect(r.status).toBe(200));
    expect(results.reduce((s, r) => s + r.body.xpChange, 0)).toBe(5);
    expect(await xpOf(learner)).toBe(5);
    expect(await XpTransaction.countDocuments({ user_id: learner._id })).toBe(1);
    expect(await GradeAttempt.countDocuments({ card_id: quizA._id, isFirst: true })).toBe(1);
  });

  test('a retried request with the same idempotencyKey is answered from the stored attempt', async () => {
    const body = { answer: { selectedOption: 1 }, idempotencyKey: 'tap-123' };
    const results = await Promise.all(Array.from({ length: 5 }, () => attempt(learner, quizA, body)));
    results.forEach((r) => expect(r.body.isCorrect).toBe(true));
    expect(await GradeAttempt.countDocuments({ card_id: quizA._id })).toBe(1);
    expect(await xpOf(learner)).toBe(5);
  });

  test('a card already completed under the old client-graded flow earns nothing new', async () => {
    await UserCardProgress.create({ user_id: learner._id, card_id: quizA._id, module_id: modA._id, isCorrect: true, xpAwarded: 5 });
    const res = await attempt(learner, quizA, { answer: { selectedOption: 1 } });
    expect(res.body).toMatchObject({ isCorrect: true, xpChange: 0, firstAttempt: false });
  });
});

describe('sequential lock and access', () => {
  test('a card in a locked module cannot be graded', async () => {
    const res = await attempt(learner, quizB, { answer: { selectedOption: 0 }, moduleId: modA._id });
    expect(res.status).toBe(403);
    expect(res.body.locked).toBe(true);
    expect(await xpOf(learner)).toBe(0);
  });

  test('passive card-completed derives the module from the card — another moduleId does not bypass the lock', async () => {
    const res = await authed(request(app).post('/api/progress/card-completed'), learner)
      .send({ cardId: knowledgeB._id, moduleId: modA._id, topicId: '' });
    expect(res.status).toBe(403);
    expect(await UserCardProgress.countDocuments({})).toBe(0);
  });

  test('completing module A unlocks module B', async () => {
    await attempt(learner, quizA, { answer: { selectedOption: 1 } });
    await attempt(learner, quizA2, { answer: { selectedOption: 2 } });
    const res = await attempt(learner, quizB, { answer: { selectedOption: 0 } });
    expect(res.status).toBe(200);
    expect(res.body.isCorrect).toBe(true);
  });

  test('topic routes now enforce the lock too', async () => {
    expect((await authed(request(app).get(`/api/topics/${modB._id}`), learner)).status).toBe(403);
    expect((await authed(request(app).get(`/api/topics/cards/${quizB._id}`), learner)).status).toBe(403);
  });

  test('a module the learner cannot see does not lock the rest of the chain', async () => {
    // Another department's module sits between A and B in the same category.
    const otherDept = await makeDepartment();
    const hidden = await Module.create({ title: 'Other dept only', visibility: 'Departmental', departments: [otherDept._id], categoryId: category._id, engineStrategy: 'EXPRESS_FLAT', hasTopics: false, order: 0.5 });
    // A card makes it a real, never-completable (for this learner) link in the chain.
    await Card.create({ module_id: hidden._id, card_type: 'knowledge', cardOrder: 1, content: { text: 'x' } });
    await attempt(learner, quizA, { answer: { selectedOption: 1 } });
    await attempt(learner, quizA2, { answer: { selectedOption: 2 } });
    // Learn page and grading must agree: B is unlocked for this learner.
    const curriculum = await authed(request(app).get('/api/modules/workspace-curriculum'), learner);
    const list = Array.isArray(curriculum.body) ? curriculum.body : (curriculum.body.modules || curriculum.body.data);
    expect(list.find((m) => m.title === 'Module B').locked).toBe(false);
    expect((await authed(request(app).get(`/api/modules/${modB._id}`), learner)).status).toBe(200);
    expect((await attempt(learner, quizB, { answer: { selectedOption: 0 } })).status).toBe(200);
  });

  test('a module outside the learner\'s department is not gradable', async () => {
    const otherDept = await makeDepartment();
    const privateMod = await Module.create({ title: 'Private', visibility: 'Departmental', departments: [otherDept._id], categoryId: null, engineStrategy: 'EXPRESS_FLAT', hasTopics: false });
    const privateQuiz = await Card.create({ module_id: privateMod._id, card_type: 'quiz', cardOrder: 1, content: { options: ['a', 'b'], correctIndex: 0 } });
    expect((await attempt(learner, privateQuiz, { answer: { selectedOption: 0 } })).status).toBe(403);
  });
});

describe('no answer-key leakage in learner-facing responses', () => {
  const FORBIDDEN_KEYS = ['correctIndex', 'answerKey', 'correctAnswerIndex', 'explanationHint', 'explanation', 'correctKey', 'correctText', 'validator'];
  // htmlSource is the module itself (accepted residual risk: a learner can
  // read the HTML source); everything else must be clean.
  function scan(value, trail = '$', hits = []) {
    if (Array.isArray(value)) value.forEach((v, i) => scan(v, `${trail}[${i}]`, hits));
    else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        if (FORBIDDEN_KEYS.includes(k)) hits.push(`${trail}.${k}`);
        if (k === 'htmlSource') continue;
        scan(v, `${trail}.${k}`, hits);
      }
    } else if (typeof value === 'string' && /data-correct|correctAnswerIndex|hint-secret/.test(value)) {
      hits.push(`${trail} (string)`);
    }
    return hits;
  }

  test.each([
    ['GET /api/modules/:id', () => `/api/modules/${modA._id}`],
    ['GET /api/topics/:id', () => `/api/topics/${modA._id}`],
    ['GET /api/topics/cards/:id (quiz)', () => `/api/topics/cards/${quizA2._id}`],
    ['GET /api/topics/cards/:id (sandbox)', () => `/api/topics/cards/${sandboxCard._id}`],
    ['GET /api/modules/:id (sandbox)', () => `/api/modules/${sandboxMod._id}`],
    ['GET /api/modules/workspace-curriculum', () => '/api/modules/workspace-curriculum'],
    ['GET /api/progress/module-scope-state (unanswered)', () => `/api/progress/module-scope-state?moduleId=${modA._id}`],
  ])('%s', async (_, url) => {
    const res = await authed(request(app).get(url()), learner);
    expect(res.status).toBe(200);
    expect(scan(res.body)).toEqual([]);
  });

  test('admins (authors) still get the full card content', async () => {
    const res = await authed(request(app).get(`/api/modules/${modA._id}`), superadmin);
    expect(res.body.cards.find((c) => c._id === String(quizA._id)).content.correctIndex).toBe(1);
  });

  test('Review Mode reveals the key only for cards the learner already answered', async () => {
    await attempt(learner, quizA, { answer: { selectedOption: 0 } });
    const res = await authed(request(app).get(`/api/progress/module-scope-state?moduleId=${modA._id}`), learner);
    const answered = res.body.cards.find((c) => c.cardId === String(quizA._id));
    const unanswered = res.body.cards.find((c) => c.cardId === String(quizA2._id));
    expect(answered).toMatchObject({ attempted: true, correctIndex: 1, explanation: 'Because.' });
    expect(unanswered.correctIndex).toBeUndefined();
    expect(unanswered.explanation).toBeUndefined();
  });
});

describe('html_sandbox grading', () => {
  const answer = (user, card, qid, chosen) => authed(request(app).post(`/api/grading/cards/${card._id}/sandbox-answer`), user).send({ qid, chosen });
  const submit = (user, card, body) => authed(request(app).post(`/api/grading/cards/${card._id}/sandbox-submit`), user).send(body);

  async function correctPayload() {
    const { answerKey } = (await Card.findById(sandboxCard._id).select('+answerKey').lean());
    return answerKey.questions.map((q) => ({
      id: q.id,
      type: q.type,
      userAnswer: q.type === 'mcq' ? q.options[q.optionKeys.indexOf(q.correctKey)] : q.correctText.split('|')[0],
    }));
  }

  test('forged sandbox score / isCorrect / points earn 0 XP', async () => {
    const questions = (await correctPayload()).map((q) => ({ ...q, userAnswer: 'definitely wrong', isCorrect: true, points: 99, correctAnswer: 'definitely wrong' }));
    const res = await submit(learner, sandboxCard, { score: 66, maxPossibleScore: 66, questions });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ score: 0, xpChange: 0 });
    expect(await xpOf(learner)).toBe(0);
    const p = await UserCardProgress.findOne({ card_id: sandboxCard._id }).lean();
    expect(p.score).toBe(0);
    expect(p.metaFeedbackLogs.questions.every((q) => q.isCorrect === false && q.points === 0)).toBe(true);
  });

  test('first answers come from the in-page bridge; in-module retries earn 0', async () => {
    expect((await answer(learner, sandboxCard, 'q1', 'A')).body).toMatchObject({ firstAnswer: true, isCorrect: false, xpChange: 0 }); // wrong first
    expect((await answer(learner, sandboxCard, 'q1', 'B')).body).toMatchObject({ firstAnswer: false, isCorrect: true, xpChange: 0 }); // retry
    expect((await answer(learner, sandboxCard, 'q2', 'B')).body).toMatchObject({ firstAnswer: true, isCorrect: true, xpChange: 5 });
    expect((await answer(learner, sandboxCard, 'q3', 'Control')).body).toMatchObject({ firstAnswer: true, isCorrect: true, xpChange: 7 });

    // Final submission is ~100% (the module only lets you finish at ≥80%),
    // but XP follows the first answers: everything except q1's 5 points.
    const res = await submit(learner, sandboxCard, { questions: await correctPayload() });
    expect(res.body.score).toBe(66);
    expect(await xpOf(learner)).toBe(61);
    const p = await UserCardProgress.findOne({ card_id: sandboxCard._id }).lean();
    expect(p).toMatchObject({ score: 66, maxScore: 66, xpAwarded: 61, isCorrect: true, gradeGeneration: 0 });

    // Submitting again changes nothing.
    await submit(learner, sandboxCard, { questions: await correctPayload() });
    expect(await xpOf(learner)).toBe(61);
  });

  test('parallel identical sandbox answers award once', async () => {
    await Promise.all(Array.from({ length: 10 }, () => answer(learner, sandboxCard, 'q2', 'B')));
    expect(await xpOf(learner)).toBe(5);
    expect(await XpTransaction.countDocuments({ user_id: learner._id })).toBe(1);
  });

  test('unknown question ids and descriptive answers are not auto-scored', async () => {
    expect((await answer(learner, sandboxCard, 'nope', 'A')).status).toBe(400);
    expect((await answer(learner, famBCard, 'q5', 'my essay')).body).toMatchObject({ recorded: false, pending: true });
  });

  test('Family B: MCQs graded at submit, descriptive answers queued for manual grading', async () => {
    const { answerKey } = await Card.findById(famBCard._id).select('+answerKey').lean();
    const questions = answerKey.questions.map((q) => (q.type === 'mcq'
      ? { id: q.id, type: 'mcq', userAnswer: q.options[q.optionKeys.indexOf(q.correctKey)], isCorrect: false }
      : { id: q.id, type: 'text', userAnswer: 'A thoughtful answer.' }));
    const res = await submit(learner, famBCard, { score: 0, questions });
    expect(res.body).toMatchObject({ score: 25, maxScore: 25, xpChange: 25, pendingManual: 4 });
    const p = await UserCardProgress.findOne({ card_id: famBCard._id }).lean();
    const descriptive = p.metaFeedbackLogs.questions.filter((q) => q.type === 'text');
    expect(descriptive).toHaveLength(4);
    expect(descriptive.every((q) => q.isCorrect === null && q.points === null && q.userAnswer === 'A thoughtful answer.')).toBe(true);
  });
});

describe('reset and manual grading through the ledger', () => {
  const reset = (user, moduleId) => authed(request(app).post('/api/progress/module-reset'), user).send({ moduleId });

  test('reset claws back, bumps the generation, and re-enables a first attempt', async () => {
    await attempt(learner, quizA, { answer: { selectedOption: 1 } });
    expect(await xpOf(learner)).toBe(5);

    const r = await reset(learner, modA._id);
    expect(r.body).toMatchObject({ success: true, xpClawedBack: 5 });
    expect(await xpOf(learner)).toBe(0);
    expect(await UserCardGeneration.findOne({ card_id: quizA._id }).lean()).toMatchObject({ generation: 1 });
    expect(await XpTransaction.findOne({ source: 'reset_clawback' }).lean()).toMatchObject({ amount: -5, generation: 0 });

    const again = await attempt(learner, quizA, { answer: { selectedOption: 1 } });
    expect(again.body).toMatchObject({ xpChange: 5, firstAttempt: true });
    expect(await xpOf(learner)).toBe(5);
  });

  test('double-clicked reset claws back only once', async () => {
    await attempt(learner, quizA, { answer: { selectedOption: 1 } });
    await Promise.all([reset(learner, modA._id), reset(learner, modA._id)]);
    expect(await xpOf(learner)).toBe(0);
    expect(await XpTransaction.countDocuments({ source: 'reset_clawback' })).toBe(1);
  });

  test('reset reverses sandbox answers awarded before the module was ever submitted', async () => {
    await authed(request(app).post(`/api/grading/cards/${sandboxCard._id}/sandbox-answer`), learner).send({ qid: 'q2', chosen: 'B' });
    expect(await xpOf(learner)).toBe(5);
    await reset(learner, sandboxMod._id);
    expect(await xpOf(learner)).toBe(0);
  });

  test('manual grade awards through the ledger and a regrade writes only the delta', async () => {
    const { answerKey } = await Card.findById(famBCard._id).select('+answerKey').lean();
    const questions = answerKey.questions.map((q) => ({ id: q.id, type: q.type === 'mcq' ? 'mcq' : 'text', userAnswer: q.type === 'mcq' ? 'zzz' : 'essay' }));
    await authed(request(app).post(`/api/grading/cards/${famBCard._id}/sandbox-submit`), learner).send({ questions });
    expect(await xpOf(learner)).toBe(0);

    const grade = (score) => authed(request(app).put(`/api/progress/admin/card/${famBCard._id}/user/${learner._id}/grade`), superadmin).send({ assignedScore: score });
    expect((await grade(8)).body.result).toMatchObject({ xpDelta: 8 });
    expect(await xpOf(learner)).toBe(8);
    expect((await grade(5)).body.result).toMatchObject({ xpDelta: -3 });
    expect(await xpOf(learner)).toBe(5);
    expect((await grade(5)).body.result).toMatchObject({ xpDelta: 0 });
    expect(await xpOf(learner)).toBe(5);

    const manual = await XpTransaction.find({ source: 'manual_grade' }).sort({ createdAt: 1 }).lean();
    expect(manual.map((t) => t.amount)).toEqual([8, -3]);
    expect((await UserCardProgress.findOne({ card_id: famBCard._id }).lean()).xpAwarded).toBe(5);
  });

  test('concurrent regrades never apply against the same previous score twice', async () => {
    const { answerKey } = await Card.findById(famBCard._id).select('+answerKey').lean();
    const questions = answerKey.questions.map((q) => ({ id: q.id, userAnswer: 'zzz' }));
    await authed(request(app).post(`/api/grading/cards/${famBCard._id}/sandbox-submit`), learner).send({ questions });
    await Promise.all([10, 10, 10].map((s) => authed(request(app).put(`/api/progress/admin/card/${famBCard._id}/user/${learner._id}/grade`), superadmin).send({ assignedScore: s })));
    expect(await xpOf(learner)).toBe(10);
  });
});
