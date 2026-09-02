// tests/streak.http.test.js
//
// The controller-level suite (streak.isolation.test.js) proves the DB query
// itself is safe. This file proves the same thing one layer up: through the
// REAL, unmodified Express router (progressRoutes.js) and the REAL auth
// middleware (auth.js) verifying an actual signed JWT — the full path a real
// HTTP request takes. src/server.js itself isn't used here (it opens a real
// DB connection from .env and calls app.listen() at import time, which would
// fight with an already-running dev server and touch real data) — instead
// this mounts the same production router in a throwaway Express app, wired
// to the same in-memory test database.
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const { connect, closeDatabase, clearCollections } = require('./setup/inMemoryMongo');
const { makeUser } = require('./setup/fixtures');
const User = require('../src/models/User');

jest.setTimeout(30000);

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret-do-not-use-in-prod';

let app;

// auth.js requires every token to arrive with the session-binding cookie
// issued at login (see authRoutes.js's issueBindingCookie) — a raw jwt.sign()
// with no `bh` claim/cookie pair is exactly the "token without its browser
// session" case that middleware now rejects. Mirror the real login flow here
// instead of weakening the check for the test.
function authFor(user) {
  const bindingSecret = crypto.randomBytes(32).toString('hex');
  const bh = crypto.createHash('sha256').update(bindingSecret).digest('hex');
  const token = jwt.sign({ user: { id: user._id.toString(), role: user.role, bh } }, process.env.JWT_SECRET, {
    expiresIn: '1h',
  });
  return { token, cookie: `orbit_bind=${bindingSecret}` };
}

function authed(req, user) {
  const { token, cookie } = authFor(user);
  return req.set('Authorization', `Bearer ${token}`).set('Cookie', cookie);
}

beforeAll(async () => {
  await connect();
  const progressRoutes = require('../src/routes/progressRoutes');
  app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/progress', progressRoutes);
});

afterAll(async () => {
  await closeDatabase();
});

afterEach(async () => {
  await clearCollections();
});

describe('HTTP integration: streak endpoints stay isolated per authenticated user', () => {
  test('POST /api/progress/streak/verify only increments the calling (JWT-identified) user', async () => {
    const userA = await makeUser({ username: 'httpUserA' });
    const userB = await makeUser({ username: 'httpUserB' });

    const res = await authed(request(app).post('/api/progress/streak/verify'), userA).send({
      actionType: 'daily_read',
    });

    expect(res.status).toBe(200);
    expect(res.body.currentStreak).toBe(1);

    const freshA = await User.findById(userA._id);
    const freshB = await User.findById(userB._id);
    expect(freshA.currentStreak).toBe(1);
    expect(freshB.currentStreak).toBe(0); // never touched by A's request

    // GET /api/progress/streak for User B, over HTTP with B's own token,
    // must report B's own (untouched) baseline — not A's.
    const resB = await authed(request(app).get('/api/progress/streak'), userB);
    expect(resB.status).toBe(200);
    expect(resB.body.currentStreak).toBe(0);
  });

  test('a request with no token is rejected before touching any user document', async () => {
    await makeUser({ username: 'httpUserC' });
    const res = await request(app).post('/api/progress/streak/verify').send({ actionType: 'daily_read' });
    expect(res.status).toBe(401);
  });

  test("two concurrent requests from different users resolve to two independent streaks", async () => {
    const userA = await makeUser({ username: 'concurrentA' });
    const userB = await makeUser({ username: 'concurrentB' });

    const [resA, resB] = await Promise.all([
      authed(request(app).post('/api/progress/streak/verify'), userA).send({ actionType: 'daily_read' }),
      authed(request(app).post('/api/progress/streak/verify'), userB).send({ actionType: 'module_progress' }),
    ]);

    expect(resA.body.currentStreak).toBe(1);
    expect(resB.body.currentStreak).toBe(1);

    const freshA = await User.findById(userA._id);
    const freshB = await User.findById(userB._id);
    expect(freshA.engagementHistory[0].actions).toEqual(['daily_read']);
    expect(freshB.engagementHistory[0].actions).toEqual(['module_progress']);
  });
});
