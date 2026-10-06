// tests/bank.test.js
//
// Question bank + Pre/Post test engine:
//   • pickForModule: Pre/Post disjoint, matched difficulty, shortages reported
//   • generate / swap / lock / versions through the admin API
//   • bank CRUD, approve, retire-instead-of-delete, Excel/CSV import
//   • AI drafts (Anthropic SDK mocked — no network)
jest.mock('@anthropic-ai/sdk', () => {
  class APIError extends Error {}
  class AuthenticationError extends APIError {}
  class RateLimitError extends APIError {}
  const create = jest.fn();
  function Anthropic() { this.beta = { messages: { create } }; }
  Anthropic.APIError = APIError;
  Anthropic.AuthenticationError = AuthenticationError;
  Anthropic.RateLimitError = RateLimitError;
  Anthropic.__create = create;
  return Anthropic;
}, { virtual: true });

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const { connect, closeDatabase, clearCollections } = require('./setup/inMemoryMongo');
const { makeUser, makeDepartment } = require('./setup/fixtures');
const Module = require('../src/models/Module');
const Category = require('../src/models/Category');
const Card = require('../src/models/Card');
const Path = require('../src/models/Path');
const BankQuestion = require('../src/models/BankQuestion');
const AssessmentForm = require('../src/models/AssessmentForm');
const AssessmentAttempt = require('../src/models/AssessmentAttempt');
const { pickForModule } = require('../src/services/formGenerator');

jest.setTimeout(60000);
process.env.JWT_SECRET = process.env.JWT_SECRET || require('crypto').randomBytes(32).toString('hex');

let app;
function authed(req, user) {
  const bindingSecret = crypto.randomBytes(32).toString('hex');
  const bh = crypto.createHash('sha256').update(bindingSecret).digest('hex');
  const token = jwt.sign({ user: { id: user._id.toString(), role: user.role, bh, sessionId: crypto.randomUUID() } }, process.env.JWT_SECRET, { expiresIn: '1h' });
  return req.set('Authorization', `Bearer ${token}`).set('Cookie', `orbit_bind=${bindingSecret}`);
}
const get = (u, url) => authed(request(app).get(url), u);
const post = (u, url, body) => authed(request(app).post(url), u).send(body || {});
const put = (u, url, body) => authed(request(app).put(url), u).send(body || {});
const del = (u, url) => authed(request(app).delete(url), u);

describe('pickForModule (pure)', () => {
  const pool = (spec) => Object.entries(spec).flatMap(([d, n]) => Array.from({ length: n }, (_, i) => ({ _id: `${d}${i}`, difficulty: d })));

  test('pairs same-difficulty questions; Pre and Post never overlap', () => {
    for (let run = 0; run < 50; run++) {
      const r = pickForModule(pool({ easy: 3, medium: 3, hard: 3 }), 3);
      expect(r.pre).toHaveLength(3);
      expect(r.post).toHaveLength(3);
      expect(r.pre.filter((id) => r.post.includes(id))).toEqual([]);
      expect(r.mismatched).toBe(0);
      const diff = (ids) => ids.map((id) => id.replace(/\d+$/, '')).sort();
      expect(diff(r.pre)).toEqual(diff(r.post));
    }
  });

  test('uses the nearest difficulty when no exact pair is left, and says so', () => {
    const r = pickForModule(pool({ easy: 1, medium: 1 }), 1);
    expect(r.pre).toHaveLength(1);
    expect(r.mismatched).toBe(1);
  });

  test('reports a shortage instead of reusing questions', () => {
    const r = pickForModule(pool({ medium: 3 }), 2);
    expect(r.shortage).toBe(1);
    expect(r.pre.length + r.post.length).toBeLessThanOrEqual(3);
    expect(new Set([...r.pre, ...r.post]).size).toBe(r.pre.length + r.post.length);
  });
});

describe('admin API', () => {
  let admin; let learner; let tag; let m1; let m2; let path;

  beforeAll(async () => {
    await connect();
    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/paths', require('../src/routes/pathRoutes'));
    app.use('/api/bank', require('../src/routes/bankRoutes'));
    await Promise.all([Path, AssessmentForm, AssessmentAttempt].map((m) => m.init()));
  });
  afterAll(closeDatabase);

  beforeEach(async () => {
    await clearCollections();
    await Promise.all([Path, AssessmentForm].map((m) => m.syncIndexes()));
    const dept = await makeDepartment();
    admin = await makeUser({ department: dept, role: 'superadmin' });
    learner = await makeUser({ department: dept });
    tag = await Category.create({ name: 'FR', visibility: 'Global' });
    [m1, m2] = await Promise.all(['Tech Stack', '3 Siblings'].map((title) => Module.create({ title, visibility: 'Global', categoryId: tag._id, engineStrategy: 'EXPRESS_FLAT', hasTopics: false })));
    path = await Path.create({ categoryId: tag._id, name: 'FR', moduleIds: [m1._id, m2._id], assessment: { enabled: true, questionsPerModule: 2 } });
  });

  const addQuestions = (mod, n, difficulty = 'medium', status = 'active') => BankQuestion.insertMany(
    Array.from({ length: n }, (_, i) => ({ moduleId: mod._id, question: `${mod.title} Q${i} ${difficulty}`, options: ['a', 'b', 'c', 'd'], correctIndex: 0, difficulty, status })),
  );

  test('generate reports shortages; lock is refused until the bank is big enough', async () => {
    await addQuestions(m1, 4);
    await addQuestions(m2, 2);
    const gen = await post(admin, `/api/paths/${path._id}/form/generate`, { perModule: 2 });
    expect(gen.body.data.form).toMatchObject({ version: 1, status: 'draft' });
    expect(gen.body.data.problems.join(' ')).toMatch(/3 Siblings.*needs 4 active questions.*has 2/);
    expect((await post(admin, `/api/paths/${path._id}/form/lock`)).status).toBe(409);
    // Publishing with Pre/Post on needs a locked test.
    expect((await post(admin, `/api/paths/${path._id}/publish`, { published: true })).body.message).toMatch(/lock the test/);

    await addQuestions(m2, 2, 'easy');
    const regen = await post(admin, `/api/paths/${path._id}/form/generate`);
    expect(regen.body.data.problems).toEqual([]);
    expect(regen.body.data.form.version).toBe(1); // a draft is regenerated in place
    const lock = await post(admin, `/api/paths/${path._id}/form/lock`);
    expect(lock.body.data).toMatchObject({ activeVersion: 1, form: { status: 'locked' } });
    expect((await post(admin, `/api/paths/${path._id}/publish`, { published: true })).status).toBe(200);
  });

  test('swap replaces one question with an unused one of the same module; locked tests are frozen', async () => {
    await addQuestions(m1, 6);
    await addQuestions(m2, 4);
    const gen = (await post(admin, `/api/paths/${path._id}/form/generate`)).body.data;
    const target = gen.form.pre.find((q) => String(q.moduleId) === String(m1._id));
    const swapped = (await post(admin, `/api/paths/${path._id}/form/swap`, { kind: 'pre', questionId: target._id })).body.data;
    const preIds = swapped.form.pre.map((q) => q._id);
    expect(preIds).not.toContain(target._id);
    const replacement = swapped.form.pre.find((q) => !gen.form.pre.some((g) => g._id === q._id));
    expect(String(replacement.moduleId)).toBe(String(m1._id));
    expect(swapped.form.post.map((q) => q._id)).not.toContain(replacement._id);

    await post(admin, `/api/paths/${path._id}/form/lock`);
    expect((await post(admin, `/api/paths/${path._id}/form/swap`, { kind: 'pre', questionId: preIds[0] })).status).toBe(409);
    // Regenerating after lock starts version 2 as a draft; v1 stays active.
    const v2 = (await post(admin, `/api/paths/${path._id}/form/generate`)).body.data;
    expect(v2).toMatchObject({ form: { version: 2, status: 'draft' }, activeVersion: 1 });
  });

  test('changing the path\'s modules flags the test for regeneration', async () => {
    await addQuestions(m1, 4); await addQuestions(m2, 4);
    await post(admin, `/api/paths/${path._id}/form/generate`);
    await Path.updateOne({ _id: path._id }, { $set: { moduleIds: [m1._id] } });
    const s = (await get(admin, `/api/paths/${path._id}/form`)).body.data;
    expect(s.problems.join(' ')).toMatch(/modules changed/);
  });

  test('bank CRUD: answers stay server-side for learners; drafts need approval; used questions retire', async () => {
    const created = await post(admin, `/api/bank/modules/${m1._id}/questions`, { question: 'What is XBRL?', options: ['A tag language', 'A spreadsheet'], correctIndex: 0, difficulty: 'easy' });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ status: 'active', correctIndex: 0, source: 'manual' });
    expect((await post(admin, `/api/bank/modules/${m1._id}/questions`, { question: 'Q', options: ['a', 'b'], correctIndex: 4 })).status).toBe(400);
    expect((await get(learner, `/api/bank/modules/${m1._id}/questions`)).status).toBe(403);

    const [draft] = await addQuestions(m1, 1, 'hard', 'draft');
    expect((await post(admin, `/api/bank/questions/${draft._id}/approve`)).body.data.status).toBe('active');

    const fresh = await BankQuestion.create({ moduleId: m1._id, question: 'unused', options: ['a', 'b'], correctIndex: 1 });
    expect((await del(admin, `/api/bank/questions/${fresh._id}`)).body).toMatchObject({ deleted: true });
    await AssessmentForm.create({ pathId: path._id, version: 1, perModule: 1, pre: [{ questionId: draft._id, moduleId: m1._id }] });
    expect((await del(admin, `/api/bank/questions/${draft._id}`)).body).toMatchObject({ retired: true });
    expect((await BankQuestion.findById(draft._id).lean()).status).toBe('retired');

    const list = (await get(admin, '/api/bank/modules')).body.data.find((m) => m.title === 'Tech Stack');
    expect(list.bank).toMatchObject({ active: 1, retired: 1, easy: 1 });
  });

  test('Excel/CSV import: dry run reports row errors; commit imports the valid rows', async () => {
    const rows = [
      { Module: 'Tech Stack', Question: 'Good row', A: 'x', B: 'y', C: '', D: 'z', Correct: 'D', Explanation: 'because', Difficulty: 'Hard' },
      { Module: 'Nope', Question: 'Bad module', A: 'x', B: 'y', Correct: 'A' },
      { Module: '3 Siblings', Question: 'Bad correct', A: 'x', B: 'y', Correct: 'C' },
      { Module: String(m2._id), Question: 'By id', A: 'x', B: 'y', Correct: 'b' },
    ];
    const dry = (await post(admin, '/api/bank/import', { rows, dryRun: true })).body;
    expect(dry).toMatchObject({ dryRun: true, total: 4, valid: 2, imported: 0 });
    expect(dry.errors.map((e) => e.row)).toEqual([3, 4]);
    expect(await BankQuestion.countDocuments()).toBe(0);

    const real = (await post(admin, '/api/bank/import', { rows, dryRun: false })).body;
    expect(real.imported).toBe(2);
    const good = await BankQuestion.findOne({ question: 'Good row' }).select('+correctIndex').lean();
    expect(good).toMatchObject({ options: ['x', 'y', 'z'], correctIndex: 2, difficulty: 'hard', source: 'import', status: 'active' });
  });

  test('AI drafts land as drafts from the module content (SDK mocked)', async () => {
    const Anthropic = require('@anthropic-ai/sdk');
    await Card.create({ module_id: m1._id, card_type: 'knowledge', cardOrder: 1, content: { title: 'Intro', text: 'An ERP records transactions. '.repeat(20) } });
    await BankQuestion.create({ moduleId: m1._id, question: 'Existing question', options: ['a', 'b'], correctIndex: 0 });
    Anthropic.__create.mockResolvedValueOnce({
      model: 'claude-opus-5-5',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify({ questions: [
        { question: 'What does an ERP record?', options: ['Transactions', 'Filings', 'Tags', 'Taxonomies'], correctIndex: 0, explanation: 'ERPs hold the ledger.', difficulty: 'easy' },
        { question: 'existing   QUESTION', options: ['a', 'b', 'c', 'd'], correctIndex: 1, explanation: 'dup', difficulty: 'medium' },
        { question: 'Broken', options: ['a'], correctIndex: 3, explanation: '', difficulty: 'hard' },
      ] }) }],
    });
    const res = await post(admin, `/api/bank/modules/${m1._id}/ai-draft`, { count: 3 });
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(1); // duplicate + invalid dropped
    const call = Anthropic.__create.mock.calls[0][0];
    expect(call).toMatchObject({ model: 'claude-opus-5-5', fallbacks: 'default', betas: ['server-side-fallback-2026-07-01'] });
    expect(call.output_config.format.type).toBe('json_schema');
    expect(call.messages[0].content).toMatch(/An ERP records transactions/);
    expect(call.messages[0].content).toMatch(/Existing question/);
    expect(await BankQuestion.findOne({ source: 'ai' }).lean()).toMatchObject({ status: 'draft', difficulty: 'easy' });

    Anthropic.__create.mockResolvedValueOnce({ stop_reason: 'refusal', content: [] });
    expect((await post(admin, `/api/bank/modules/${m1._id}/ai-draft`, { count: 3 })).status).toBe(422);
  });
});
