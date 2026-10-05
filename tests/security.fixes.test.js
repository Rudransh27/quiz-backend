// tests/security.fixes.test.js
//
// Regression tests for the 2026-10-05 security review:
//   A  users can't move themselves between departments / into other teams
//   D  the client's "today" is only trusted within ±1 day (no XP farming)
//   E  Mongo operator objects in auth inputs are refused; no account enumeration
//   F  admins can't take over / delete Global modules or set platform flags
//   G  tokens must carry a sessionId; a password change ends older sessions
require('dotenv').config({ quiet: true }); // authRoutes → msalClient needs its env
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const axios = require('axios');
const { connect, closeDatabase, clearCollections } = require('./setup/inMemoryMongo');
const { makeUser, makeDepartment } = require('./setup/fixtures');
const User = require('../src/models/User');
const Team = require('../src/models/Team');
const Module = require('../src/models/Module');
const Category = require('../src/models/Category');
const { resolveClientToday } = require('../src/utils/localDate');

jest.mock('axios'); // reCAPTCHA siteverify
jest.mock('../src/utils/sendEmail', () => jest.fn(async () => ({ messageId: 'test' })));
jest.setTimeout(60000);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret-do-not-use-in-prod';

let app;
function session(user, claims = {}, opts = {}) {
  const bindingSecret = crypto.randomBytes(32).toString('hex');
  const bh = crypto.createHash('sha256').update(bindingSecret).digest('hex');
  const token = jwt.sign({ user: { id: user._id.toString(), role: user.role, bh, sessionId: crypto.randomUUID(), ...claims } }, process.env.JWT_SECRET, { expiresIn: '1h', ...opts });
  return { token, cookie: `orbit_bind=${bindingSecret}` };
}
const as = (req, s) => req.set('Authorization', `Bearer ${s.token}`).set('Cookie', s.cookie);

beforeAll(async () => {
  await connect();
  app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', require('../src/routes/authRoutes'));
  app.use('/api/modules', require('../src/routes/moduleRoutes'));
});
afterAll(closeDatabase);
beforeEach(() => { axios.post.mockResolvedValue({ data: { success: true } }); });
afterEach(clearCollections);

const team = (dept, extra = {}) => Team.create({ name: `T${Math.random()}`, code: `t${Date.now()}${Math.floor(Math.random() * 1e6)}`, department_id: dept._id, ...extra });

describe('A — department / team are not self-service after onboarding', () => {
  test('complete-profile refuses once a department is set', async () => {
    const user = await makeUser();
    const other = await makeDepartment();
    const res = await as(request(app).put('/api/auth/complete-profile'), session(user)).send({ department: other.code });
    expect(res.status).toBe(409);
    expect(String((await User.findById(user._id)).department)).toBe(String(user.department));
  });

  test('onboarding keeps only a non-Council team of the chosen department', async () => {
    const user = await makeUser();
    await User.updateOne({ _id: user._id }, { $unset: { department: 1, team: 1 } });
    const dept = await makeDepartment();
    const otherDept = await makeDepartment();
    const council = await team(dept, { isCouncil: true });
    const foreign = await team(otherDept);
    const mine = await team(dept);
    const s = session(user);

    for (const [teamId, expected] of [[council._id, null], [foreign._id, null]]) {
      await User.updateOne({ _id: user._id }, { $unset: { department: 1, team: 1 } });
      const r = await as(request(app).put('/api/auth/complete-profile'), s).send({ department: dept.code, teamId: String(teamId) });
      expect(r.status).toBe(200);
      expect((await User.findById(user._id)).team).toBe(expected);
    }
    await User.updateOne({ _id: user._id }, { $unset: { department: 1, team: 1 } });
    await as(request(app).put('/api/auth/complete-profile'), s).send({ department: dept.code, teamId: String(mine._id) });
    expect(String((await User.findById(user._id)).team)).toBe(String(mine._id));
  });

  test('a made-up department id is refused', async () => {
    const user = await makeUser();
    await User.updateOne({ _id: user._id }, { $unset: { department: 1 } });
    const r = await as(request(app).put('/api/auth/complete-profile'), session(user)).send({ department: '64b000000000000000000000' });
    expect(r.status).toBe(400);
  });

  test('update-profile ignores teamId', async () => {
    const user = await makeUser();
    const council = await team(await makeDepartment(), { isCouncil: true });
    const r = await as(request(app).put('/api/auth/update-profile'), session(user)).send({ username: user.username, teamId: String(council._id) });
    expect(r.status).toBe(200);
    expect((await User.findById(user._id)).team).toBeFalsy();
  });
});

describe('D — client date is clamped to ±1 day', () => {
  const now = new Date('2026-10-05T12:00:00Z');
  test.each([
    ['2026-10-04', '2026-10-04'], ['2026-10-05', '2026-10-05'], ['2026-10-06', '2026-10-06'],
    ['2001-01-01', '2026-10-05'], ['2026-10-08', '2026-10-05'], [{ $gt: '' }, '2026-10-05'], [undefined, '2026-10-05'],
  ])('%p → %p', (input, expected) => expect(resolveClientToday(input, now)).toBe(expected));
});

describe('E — auth inputs must be plain strings; no enumeration', () => {
  test('login with an operator object is refused without touching any account', async () => {
    await makeUser();
    const r = await request(app).post('/api/auth/login').send({ email: { $ne: null }, password: 'x', captchaToken: 't' });
    expect(r.status).toBe(400);
    expect(r.body.message).toBe('Invalid credentials');
  });

  test('an unverified account is only revealed after the right password', async () => {
    const user = await makeUser({ password: 'Correct-horse-1' });
    await User.updateOne({ _id: user._id }, { $set: { isVerified: false } });
    const wrong = await request(app).post('/api/auth/login').send({ email: user.email, password: 'nope', captchaToken: 't' });
    expect(wrong.status).toBe(400);
    const right = await request(app).post('/api/auth/login').send({ email: user.email, password: 'Correct-horse-1', captchaToken: 't' });
    expect(right.status).toBe(401);
  });

  test('verify-email: operator object refused; 5 wrong codes burn the code', async () => {
    const user = await makeUser();
    const otp = '123456';
    await User.updateOne({ _id: user._id }, { $set: {
      isVerified: false,
      emailVerificationToken: crypto.createHash('sha256').update(otp).digest('hex'),
      emailVerificationExpire: new Date(Date.now() + 600000),
    } });
    expect((await request(app).post('/api/auth/verify-email').send({ email: { $ne: null }, otp })).status).toBe(400);
    for (let i = 0; i < 5; i++) {
      expect((await request(app).post('/api/auth/verify-email').send({ email: user.email, otp: String(100000 + i) })).status).toBe(400);
    }
    // the right code no longer works — it was burned after 5 misses
    expect((await request(app).post('/api/auth/verify-email').send({ email: user.email, otp })).status).toBe(400);
    expect((await User.findById(user._id)).isVerified).toBe(false);
  });

  test('forgot-password answers identically for real, unknown and operator emails', async () => {
    const user = await makeUser();
    const bodies = [];
    for (const email of [user.email, 'nobody@irisregtech.com', { $regex: '^t' }]) {
      const r = await request(app).post('/api/auth/forgot-password').send({ email, captchaToken: 't' });
      expect(r.status).toBe(200);
      bodies.push(r.body.message);
    }
    expect(new Set(bodies).size).toBe(1);
  });
});

describe('F — Global modules and platform flags', () => {
  let cat;
  beforeEach(async () => { cat = await Category.create({ name: `C${Date.now()}` }); });
  const globalModule = (owner) => Module.create({ title: 'Company-wide', visibility: 'Global', engineStrategy: 'EXPRESS_FLAT', hasTopics: false, categoryId: cat._id, createdBy: owner._id });

  test('the request body cannot set createdBy or featured flags', async () => {
    const owner = await makeUser({ role: 'superadmin' });
    const admin = await makeUser({ role: 'admin' });
    const mod = await globalModule(owner);
    const r = await as(request(app).put(`/api/modules/${mod._id}`), session(admin)).send({ title: 'Edited', createdBy: String(admin._id), isHotModule: true, isPopular: true });
    expect(r.status).toBe(200);
    const after = await Module.findById(mod._id);
    expect(String(after.createdBy)).toBe(String(owner._id));
    expect(after.isHotModule).toBeFalsy();
    expect(after.isPopular).toBeFalsy();
  });

  test("a department admin can't delete someone else's Global module", async () => {
    const owner = await makeUser({ role: 'superadmin' });
    const admin = await makeUser({ role: 'admin' });
    const mod = await globalModule(owner);
    expect((await as(request(app).delete(`/api/modules/${mod._id}`), session(admin))).status).toBe(403);
    expect(await Module.findById(mod._id)).not.toBeNull();
    const own = await globalModule(admin);
    expect((await as(request(app).delete(`/api/modules/${own._id}`), session(admin))).status).toBe(200);
  });

  test('hot / popular flags are superadmin-only', async () => {
    const admin = await makeUser({ role: 'admin' });
    const superadmin = await makeUser({ role: 'superadmin' });
    const mod = await globalModule(superadmin);
    expect((await as(request(app).patch(`/api/modules/${mod._id}/hot-module`), session(admin)).send({ isHotModule: true })).status).toBe(403);
    expect((await as(request(app).patch(`/api/modules/${mod._id}/popular`), session(admin)).send({ isPopular: true })).status).toBe(403);
    expect((await as(request(app).patch(`/api/modules/${mod._id}/hot-module`), session(superadmin)).send({ isHotModule: true })).status).toBe(200);
  });
});

describe('G — sessions', () => {
  test('a token without a sessionId is refused', async () => {
    const user = await makeUser();
    const s = session(user, { sessionId: undefined });
    expect((await as(request(app).put('/api/auth/update-profile'), s).send({ username: 'x' })).status).toBe(401);
  });

  test('changing the password ends older sessions and hands this browser a new one', async () => {
    const user = await makeUser({ password: 'Old-password-1' });
    // an "older" session, issued a minute ago (e.g. a thief's copy)
    const old = session(user, {}, {});
    const oldToken = jwt.sign({ ...jwt.decode(old.token), iat: Math.floor(Date.now() / 1000) - 60 }, process.env.JWT_SECRET);
    const stale = { token: oldToken, cookie: old.cookie };
    expect((await as(request(app).put('/api/auth/update-profile'), stale).send({ username: user.username })).status).toBe(200);

    const change = await as(request(app).put('/api/auth/change-password'), session(user)).send({ currentPassword: 'Old-password-1', newPassword: 'New-password-2' });
    expect(change.status).toBe(200);
    expect(change.body.token).toBeTruthy();

    expect((await as(request(app).put('/api/auth/update-profile'), stale).send({ username: user.username })).status).toBe(401);
    const cookie = change.headers['set-cookie'].find((c) => c.startsWith('orbit_bind=')).split(';')[0];
    const fresh = await request(app).put('/api/auth/update-profile').set('Authorization', `Bearer ${change.body.token}`).set('Cookie', cookie).send({ username: user.username });
    expect(fresh.status).toBe(200);
  });
});
