// tests/streakProof.test.js
//
// Streak claims must be backed by a real, recent activity on the server:
// daily_read (an open of a read ≥ 25s ago), module_progress (a completed
// topic/module), idea_submission (an idea). Also the read-open endpoint.
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const { connect, closeDatabase, clearCollections } = require('./setup/inMemoryMongo');
const { makeUser, makeDepartment } = require('./setup/fixtures');
const User = require('../src/models/User');
const DailyRead = require('../src/models/DailyRead');
const DailyReadOpen = require('../src/models/DailyReadOpen');
const Idea = require('../src/models/Idea');
const UserTopicProgress = require('../src/models/UserTopicProgress');
const { hasActivityProof } = require('../src/services/streakProof');
const mongoose = require('mongoose');

jest.setTimeout(60000);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret-do-not-use-in-prod';

let app;
function authed(req, user) {
  const bindingSecret = crypto.randomBytes(32).toString('hex');
  const bh = crypto.createHash('sha256').update(bindingSecret).digest('hex');
  const token = jwt.sign({ user: { id: user._id.toString(), role: user.role, bh, sessionId: crypto.randomUUID() } }, process.env.JWT_SECRET, { expiresIn: '1h' });
  return req.set('Authorization', `Bearer ${token}`).set('Cookie', `orbit_bind=${bindingSecret}`);
}

beforeAll(async () => {
  await connect();
  app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/progress', require('../src/routes/progressRoutes'));
  app.use('/api/daily-reads', require('../src/routes/dailyReadRoutes'));
  await DailyReadOpen.init();
});
afterAll(closeDatabase);
afterEach(clearCollections);

const verify = (user, actionType) => authed(request(app).post('/api/progress/streak/verify'), user).send({ actionType });

async function makeRead(dept) {
  const author = await makeUser({ department: dept, role: 'admin' });
  return DailyRead.create({
    title: 'Today', content: 'Body', department: dept._id, dateKey: new Date().toISOString().slice(0, 10), createdBy: author._id, author: author._id,
  }).catch(async () => DailyRead.collection.insertOne({ title: 'Today', content: 'Body', department: dept._id, dateKey: new Date().toISOString().slice(0, 10) })
    .then((r) => ({ _id: r.insertedId })));
}

test('a streak claim with no matching activity is refused and pays nothing', async () => {
  const user = await makeUser();
  for (const action of ['daily_read', 'module_progress', 'idea_submission']) {
    const res = await verify(user, action);
    expect(res.status).toBe(409);
  }
  const fresh = await User.findById(user._id).lean();
  expect(fresh.xp).toBe(0);
  expect(fresh.currentStreak || 0).toBe(0);
});

test('daily_read needs a server-recorded open at least 25s earlier', async () => {
  const dept = await makeDepartment();
  const user = await makeUser({ department: dept });
  const read = await makeRead(dept);

  const open = await authed(request(app).post(`/api/daily-reads/${read._id}/open`), user);
  expect(open.status).toBe(200);
  // Opening again the same day keeps the FIRST open time.
  const first = (await DailyReadOpen.findOne({ user_id: user._id }).lean()).openedAt;
  await authed(request(app).post(`/api/daily-reads/${read._id}/open`), user);
  expect((await DailyReadOpen.findOne({ user_id: user._id }).lean()).openedAt).toEqual(first);

  expect((await verify(user, 'daily_read')).status).toBe(409); // too soon
  await DailyReadOpen.updateOne({ user_id: user._id }, { $set: { openedAt: new Date(Date.now() - 31000) } });
  const ok = await verify(user, 'daily_read');
  expect(ok.status).toBe(200);
  expect(ok.body).toMatchObject({ streakIncremented: true, pointsAwarded: 10 });
});

test('another department\'s read cannot be "opened"', async () => {
  const user = await makeUser();
  const read = await makeRead(await makeDepartment());
  expect((await authed(request(app).post(`/api/daily-reads/${read._id}/open`), user)).status).toBe(404);
  expect(await DailyReadOpen.countDocuments()).toBe(0);
});

test('module_progress and idea_submission are backed by real records from the last day', async () => {
  const user = await makeUser();
  const now = new Date();
  expect((await hasActivityProof(user._id, 'module_progress', now)).ok).toBe(false);
  await UserTopicProgress.create({ user_id: user._id, topic_id: new mongoose.Types.ObjectId(), module_id: new mongoose.Types.ObjectId(), isCompleted: true });
  expect((await hasActivityProof(user._id, 'module_progress', now)).ok).toBe(true);
  // A completion older than a day doesn't count.
  expect((await hasActivityProof(user._id, 'module_progress', new Date(Date.now() + 25 * 3600 * 1000))).ok).toBe(false);

  expect((await hasActivityProof(user._id, 'idea_submission', now)).ok).toBe(false);
  await Idea.collection.insertOne({ userId: user._id, title: 'Idea', createdAt: new Date() });
  expect((await hasActivityProof(user._id, 'idea_submission', now)).ok).toBe(true);
  expect((await verify(user, 'idea_submission')).status).toBe(200);
});
