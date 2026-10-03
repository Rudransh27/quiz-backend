// tests/paths.http.test.js
//
// Tags → Paths through the real routers + auth middleware on an in-memory
// MongoDB: Path visibility (status, audience, module visibility), per-Path
// sequential unlock in the Path's own order, hidden modules outside Paths,
// shared modules across Paths, the Pre gate, admin publish rules, and the
// migration planner.
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
const Region = require('../src/models/Region');
const BankQuestion = require('../src/models/BankQuestion');
const AssessmentForm = require('../src/models/AssessmentForm');
const AssessmentAttempt = require('../src/models/AssessmentAttempt');
const UserCardProgress = require('../src/models/UserCardProgress');
const { invalidatePathsEnabled } = require('../src/services/paths');
const { planForCategory } = require('../scripts/migrate-tags-to-paths');

jest.setTimeout(60000);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret-do-not-use-in-prod';

let app;
function authed(req, user) {
  const bindingSecret = crypto.randomBytes(32).toString('hex');
  const bh = crypto.createHash('sha256').update(bindingSecret).digest('hex');
  const token = jwt.sign({ user: { id: user._id.toString(), role: user.role, bh } }, process.env.JWT_SECRET, { expiresIn: '1h' });
  return req.set('Authorization', `Bearer ${token}`).set('Cookie', `orbit_bind=${bindingSecret}`);
}
const get = (user, url) => authed(request(app).get(url), user);
const post = (user, url, body) => authed(request(app).post(url), user).send(body || {});
const put = (user, url, body) => authed(request(app).put(url), user).send(body || {});
const listOf = (body) => (Array.isArray(body) ? body : body.data);

beforeAll(async () => {
  await connect();
  app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/learn', require('../src/routes/learnRoutes'));
  app.use('/api/paths', require('../src/routes/pathRoutes'));
  app.use('/api/modules', require('../src/routes/moduleRoutes'));
  app.use('/api/grading', require('../src/routes/gradingRoutes'));
  await Promise.all([Card, Path, AssessmentAttempt, UserCardProgress].map((m) => m.init()));
});
afterAll(closeDatabase);

let dept; let learner; let superadmin; let tag; let m1; let m2; let m3; let hiddenMod; let q1; let q2; let q3;
const flat = { visibility: 'Global', engineStrategy: 'EXPRESS_FLAT', hasTopics: false };

beforeEach(async () => {
  await clearCollections();
  await Promise.all([Card, Path, AssessmentAttempt, UserCardProgress].map((m) => m.syncIndexes()));
  invalidatePathsEnabled();
  dept = await makeDepartment();
  learner = await makeUser({ department: dept });
  superadmin = await makeUser({ department: dept, role: 'superadmin' });
  tag = await Category.create({ name: 'Financial Reporting', visibility: 'Global', sequentialUnlock: true });
  // Module.order deliberately DIFFERENT from the Path order used below.
  m1 = await Module.create({ ...flat, title: 'Tech Stack', categoryId: tag._id, order: 3 });
  m2 = await Module.create({ ...flat, title: '3 Siblings', categoryId: tag._id, order: 2 });
  m3 = await Module.create({ ...flat, title: 'Under the Hood', categoryId: tag._id, order: 1 });
  hiddenMod = await Module.create({ ...flat, title: 'Not in any path', categoryId: tag._id, order: 0 });
  const quiz = (mod) => Card.create({ module_id: mod._id, card_type: 'quiz', cardOrder: 1, content: { options: ['a', 'b'], correctIndex: 0 } });
  [q1, q2, q3] = await Promise.all([quiz(m1), quiz(m2), quiz(m3)]);
  await quiz(hiddenMod);
});

async function publishPath(fields) {
  const created = await post(superadmin, '/api/paths', { categoryId: tag._id, ...fields });
  expect(created.status).toBe(201);
  const pub = await post(superadmin, `/api/paths/${created.body.data._id}/publish`, { published: true });
  expect(pub.status).toBe(200);
  invalidatePathsEnabled();
  return created.body.data;
}
const answer = (card, opt = 0) => post(learner, `/api/grading/cards/${card._id}/attempt`, { answer: { selectedOption: opt } });

describe('learner navigation', () => {
  test('Tag → Path → modules in the Path\'s own order, with sequential locks', async () => {
    const p = await publishPath({ name: 'FR – India', moduleIds: [m1._id, m2._id, m3._id] });

    const tags = await get(learner, '/api/learn/tags');
    expect(tags.body.data).toHaveLength(1);
    expect(tags.body.data[0]).toMatchObject({ name: 'Financial Reporting', pathCount: 1, moduleCount: 3 });

    const list = await get(learner, `/api/learn/tags/${tag._id}/paths`);
    expect(list.body.data.map((x) => x.name)).toEqual(['FR – India']);

    const detail = await get(learner, `/api/learn/paths/${p._id}`);
    expect(detail.body.data.modules.map((m) => [m.title, m.locked])).toEqual([
      ['Tech Stack', false], ['3 Siblings', true], ['Under the Hood', true],
    ]);
    expect(detail.body.data.modules[0].totalCardCount).toBe(1);
    expect(JSON.stringify(detail.body)).not.toMatch(/correctIndex|answerKey/);

    expect((await answer(q2)).status).toBe(403);       // locked by Path order
    expect((await answer(q1)).status).toBe(200);
    expect((await answer(q2)).status).toBe(200);       // now open
    const after = await get(learner, `/api/learn/paths/${p._id}`);
    expect(after.body.data.modules.map((m) => m.locked)).toEqual([false, false, false]);
    expect(after.body.data.completedCount).toBe(2);
  });

  test('a module in no published Path is hidden from learners (curriculum, GET, grading)', async () => {
    await publishPath({ name: 'FR', moduleIds: [m1._id] });
    const curriculum = listOf((await get(learner, '/api/modules/workspace-curriculum')).body);
    expect(curriculum.map((m) => m.title)).toEqual(['Tech Stack']);
    expect((await get(learner, `/api/modules/${hiddenMod._id}`)).status).toBe(403);
    // Admins still see and open everything.
    expect((await get(superadmin, `/api/modules/${hiddenMod._id}`)).status).toBe(200);
  });

  test('before any Path is published the old per-tag lock still applies', async () => {
    const curriculum = listOf((await get(learner, '/api/modules/workspace-curriculum')).body);
    expect(curriculum).toHaveLength(4);
  });

  test('drafts and other audiences are invisible to the learner', async () => {
    const other = await makeDepartment();
    const draft = (await post(superadmin, '/api/paths', { categoryId: tag._id, name: 'Draft', moduleIds: [m1._id] })).body.data;
    await publishPath({ name: 'Other dept', moduleIds: [m2._id], audience: { departments: [other._id] } });
    await publishPath({ name: 'Mine', moduleIds: [m3._id], audience: { departments: [dept._id] } });

    const names = (await get(learner, `/api/learn/tags/${tag._id}/paths`)).body.data.map((x) => x.name);
    expect(names).toEqual(['Mine']);
    expect((await get(learner, `/api/learn/paths/${draft._id}`)).status).toBe(404);
    expect((await get(superadmin, `/api/learn/paths/${draft._id}`)).status).toBe(200); // admin preview
  });

  test('a Path whose modules the learner cannot see is not shown', async () => {
    const other = await makeDepartment();
    const privateMod = await Module.create({ ...flat, title: 'Private', visibility: 'Departmental', departments: [other._id], categoryId: tag._id });
    await publishPath({ name: 'Only private', moduleIds: [privateMod._id] });
    expect((await get(learner, '/api/learn/tags')).body.data).toHaveLength(0);
  });

  test('a shared module completed once counts in every Path that contains it', async () => {
    const a = await publishPath({ name: 'Path A', moduleIds: [m1._id, m2._id] });
    const b = await publishPath({ name: 'Path B', moduleIds: [m1._id, m3._id] });
    await answer(q1);
    const pa = (await get(learner, `/api/learn/paths/${a._id}`)).body.data;
    const pb = (await get(learner, `/api/learn/paths/${b._id}`)).body.data;
    expect(pa.modules[0].completed).toBe(true);
    expect(pb.modules[0].completed).toBe(true);
    expect(pb.modules[1].locked).toBe(false);
  });

  test('regional audience: a learner with a region sees only matching Paths', async () => {
    const india = await Region.create({ name: 'India', code: 'IN' });
    const europe = await Region.create({ name: 'Europe', code: 'EU' });
    await publishPath({ name: 'FR – India', moduleIds: [m1._id], audience: { regions: [india._id] } });
    await publishPath({ name: 'FR – Europe', moduleIds: [m2._id], audience: { regions: [europe._id] } });
    await learner.updateOne({ regions: [europe._id] });
    expect((await get(learner, `/api/learn/tags/${tag._id}/paths`)).body.data.map((x) => x.name)).toEqual(['FR – Europe']);
    const legacy = await get(learner, `/api/learn/legacy-path?categoryId=${tag._id}&regionId=${europe._id}`);
    expect(legacy.body.pathId).toBeTruthy();
  });

  test('sequentialUnlock:false opens every module', async () => {
    const p = await publishPath({ name: 'Open', moduleIds: [m1._id, m2._id, m3._id], sequentialUnlock: false });
    const d = (await get(learner, `/api/learn/paths/${p._id}`)).body.data;
    expect(d.modules.every((m) => !m.locked)).toBe(true);
  });
});

describe('Pre/Post gates', () => {
  async function pathWithAssessment() {
    const created = (await post(superadmin, '/api/paths', { categoryId: tag._id, name: 'Assessed', moduleIds: [m1._id, m2._id], assessment: { enabled: true, questionsPerModule: 1 } })).body.data;
    await BankQuestion.insertMany([m1, m2].flatMap((m) => [0, 1].map((i) => ({ moduleId: m._id, question: `${m.title} Q${i}`, options: ['a', 'b'], correctIndex: 0 }))));
    await post(superadmin, `/api/paths/${created._id}/form/generate`);
    expect((await post(superadmin, `/api/paths/${created._id}/form/lock`)).status).toBe(200);
    expect((await post(superadmin, `/api/paths/${created._id}/publish`, { published: true })).status).toBe(200);
    invalidatePathsEnabled();
    return created;
  }

  test('first module waits for Pre; Pre done opens it', async () => {
    const p = await pathWithAssessment();
    let d = (await get(learner, `/api/learn/paths/${p._id}`)).body.data;
    expect(d.assessment).toMatchObject({ enabled: true, preRequired: true, preDone: false });
    expect(d.modules.every((m) => m.locked)).toBe(true);
    expect((await answer(q1)).status).toBe(403);

    await AssessmentAttempt.create({ user_id: learner._id, pathId: p._id, kind: 'pre', score: 2, maxScore: 5, percent: 40 });
    d = (await get(learner, `/api/learn/paths/${p._id}`)).body.data;
    expect(d.modules[0].locked).toBe(false);
    expect(d.assessment).toMatchObject({ preDone: true, prePercent: 40, postUnlocked: false });

    await answer(q1); await answer(q2);
    d = (await get(learner, `/api/learn/paths/${p._id}`)).body.data;
    expect(d.assessment.postUnlocked).toBe(true);
  });

  test('a learner who already had progress skips Pre ("no baseline")', async () => {
    await UserCardProgress.create({ user_id: learner._id, card_id: q1._id, module_id: m1._id, isCorrect: true });
    const p = await pathWithAssessment();
    const d = (await get(learner, `/api/learn/paths/${p._id}`)).body.data;
    expect(d.assessment).toMatchObject({ preRequired: false, noBaseline: true });
    expect(d.modules[0].locked).toBe(false);
  });
});

describe('admin rules', () => {
  test('publishing needs ≥1 module, and a locked Pre/Post test when Pre/Post is on', async () => {
    const empty = (await post(superadmin, '/api/paths', { categoryId: tag._id, name: 'Empty' })).body.data;
    expect((await post(superadmin, `/api/paths/${empty._id}/publish`, { published: true })).status).toBe(400);

    const assessed = (await post(superadmin, '/api/paths', { categoryId: tag._id, name: 'A', moduleIds: [m1._id], assessment: { enabled: true } })).body.data;
    const res = await post(superadmin, `/api/paths/${assessed._id}/publish`, { published: true });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/lock the test/);
  });

  test('learners cannot use the admin Path API', async () => {
    expect((await post(learner, '/api/paths', { categoryId: tag._id, name: 'x' })).status).toBe(403);
  });

  test('duplicate copies modules and Pre/Post settings as a draft (its own test is generated separately)', async () => {
    const src = (await post(superadmin, '/api/paths', { categoryId: tag._id, name: 'India', moduleIds: [m1._id, m2._id], assessment: { enabled: true, questionsPerModule: 3 } })).body.data;
    const copy = (await post(superadmin, `/api/paths/${src._id}/duplicate`)).body.data;
    expect(copy).toMatchObject({ name: 'India (copy)', status: 'draft', assessment: { enabled: true, questionsPerModule: 3 }, test: { latestVersion: null } });
    expect(copy.moduleIds.map(String)).toEqual([m1._id, m2._id].map(String));
    expect(await AssessmentForm.countDocuments({ pathId: copy._id })).toBe(0);
  });

  test('editing keeps only modules the admin may use', async () => {
    const p = (await post(superadmin, '/api/paths', { categoryId: tag._id, name: 'P' })).body.data;
    const res = await put(superadmin, `/api/paths/${p._id}`, { moduleIds: [m3._id, m1._id], audience: { regions: ['not-an-id'] } });
    expect(res.status).toBe(200);
    expect(res.body.data.modules.map((m) => m.title)).toEqual(['Under the Hood', 'Tech Stack']);
    expect(res.body.data.audience.regions).toEqual([]);
  });
});

describe('migration planner', () => {
  const r = (id) => ({ _id: id });
  const names = new Map([['IN', 'India'], ['EU', 'Europe'], ['US', 'United States'], ['AP', 'APAC']]);
  const cat = { _id: 'cat', name: 'Foundation', sequentialUnlock: true };

  test('no region-specific modules → one Path for everyone', () => {
    const plan = planForCategory(cat, [{ _id: 'a', regions: [] }, { _id: 'b' }], names, ['IN', 'EU']);
    expect(plan).toEqual([expect.objectContaining({ name: 'Foundation', regionIds: [], moduleIds: ['a', 'b'] })]);
  });

  test('regions with identical lists share a Path; others get their own', () => {
    const mods = [
      { _id: 'tech', regions: ['IN', 'US', 'AP'].map(r) },
      { _id: 'siblings', regions: ['IN', 'US', 'AP', 'EU'].map(r) },
    ];
    const plan = planForCategory(cat, mods, names, ['IN', 'EU', 'US', 'AP']);
    expect(plan.map((p) => [p.name, p.regionIds.sort(), p.moduleIds])).toEqual([
      ['Foundation', ['AP', 'IN', 'US'], ['tech', 'siblings']],
      ['Foundation – Europe', ['EU'], ['siblings']],
    ]);
  });

  test('all regions seeing the same list collapses to one Path', () => {
    const plan = planForCategory(cat, [{ _id: 'a', regions: [r('US')] }], names, ['US', 'EU']);
    expect(plan).toEqual([expect.objectContaining({ name: 'Foundation', regionIds: [], moduleIds: ['a'] })]);
  });
});
