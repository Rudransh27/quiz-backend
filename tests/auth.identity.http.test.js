// tests/auth.identity.http.test.js
//
// One IRIS Orbit user per person across Microsoft SSO and password login,
// the sign-in method on every login, the auth audit log, sessions (logout,
// expiry, revoke, password events) and the admin sign-in activity view —
// through the real routers. Only the outside world is mocked: Microsoft
// (msalClient), Google reCAPTCHA (axios) and the mail transport.
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const axios = require('axios');
const { connect, closeDatabase, clearCollections } = require('./setup/inMemoryMongo');
const { makeUser, makeDepartment } = require('./setup/fixtures');
const User = require('../src/models/User');
const AuthEvent = require('../src/models/AuthEvent');
const AuthSession = require('../src/models/AuthSession');
const AuthIdentity = require('../src/models/AuthIdentity');
const UserCardProgress = require('../src/models/UserCardProgress');
const AssessmentAttempt = require('../src/models/AssessmentAttempt');

jest.mock('axios');
jest.mock('../src/utils/sendEmail', () => jest.fn(async () => {}));
jest.mock('../src/utils/msalClient', () => ({
  msalClient: {
    getAuthCodeUrl: jest.fn(async (r) => `https://login.microsoftonline.test/authorize?state=${r.state}`),
    acquireTokenByCode: jest.fn(),
  },
  MICROSOFT_SCOPES: ['openid', 'profile', 'email'],
  getMicrosoftRedirectUri: () => 'http://localhost/api/auth/microsoft/callback',
}));
const sendEmail = require('../src/utils/sendEmail');
const { msalClient } = require('../src/utils/msalClient');

jest.setTimeout(60000);
const TENANT = '11111111-2222-3333-4444-555555555555';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret-do-not-use-in-prod';
process.env.MICROSOFT_TENANT_ID = TENANT;
process.env.CLIENT_URL = 'http://client.test';
const PASSWORD = 'password123'; // tests/setup/fixtures.js makeUser default

let app;
let loginLimiterStore;
beforeAll(async () => {
  await connect();
  app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', require('../src/routes/authRoutes'));
  app.use('/api/admin/auth', require('../src/routes/authActivityRoutes'));
  ({ loginLimiterStore } = require('../src/middleware/rateLimiters'));
  await Promise.all([User, AuthEvent, AuthSession, AuthIdentity].map((m) => m.init()));
});
afterAll(closeDatabase);

let dept;
beforeEach(async () => {
  await clearCollections();
  await Promise.all([User, AuthEvent, AuthSession, AuthIdentity].map((m) => m.syncIndexes()));
  loginLimiterStore.resetAll();
  axios.post.mockResolvedValue({ data: { success: true } }); // reCAPTCHA "solved"
  sendEmail.mockClear();
  delete process.env.AUTH_SINGLE_SESSION;
  delete process.env.AUTH_SSO_PASSWORD_LOGIN;
  dept = await makeDepartment();
});

const cookieOf = (res, name) => (res.headers['set-cookie'] || []).find((c) => c.startsWith(`${name}=`))?.split(';')[0];
const msClaims = (over = {}) => ({ oid: 'oid-aashima', tid: TENANT, email: 'aashima.singh@irisregtech.com', name: 'Aashima Singh', ...over });

// Full Microsoft round trip: /microsoft (state + PKCE cookie) → Microsoft
// (mocked) → /microsoft/callback. Returns our session or the error code.
async function ssoLogin(claims) {
  const start = await request(app).get('/api/auth/microsoft');
  const state = new URL(start.headers.location).searchParams.get('state');
  msalClient.acquireTokenByCode.mockResolvedValueOnce({ idTokenClaims: claims });
  const cb = await request(app).get(`/api/auth/microsoft/callback?code=abc&state=${state}`).set('Cookie', cookieOf(start, 'orbit_sso'));
  const loc = cb.headers.location || '';
  return {
    token: loc.includes('#token=') ? loc.split('#token=')[1] : null,
    error: new URL(loc.replace('#', '?_frag=')).searchParams.get('error'),
    cookie: cookieOf(cb, 'orbit_bind'),
  };
}
async function localLogin(email, password = PASSWORD) {
  const res = await request(app).post('/api/auth/login').send({ email, password, captchaToken: 'ok' });
  return { res, token: res.body.token || null, cookie: cookieOf(res, 'orbit_bind') };
}
const as = (s, req) => req.set('Authorization', `Bearer ${s.token}`).set('Cookie', s.cookie);
const validate = (s) => as(s, request(app).post('/api/auth/validate')).send({});
const events = (filter = {}) => AuthEvent.find(filter).sort({ createdAt: 1 }).lean();

test('new user signs in with Microsoft: one account, SSO method recorded, last login set', async () => {
  const s = await ssoLogin(msClaims());
  expect(s.error).toBeNull();
  const users = await User.find({ email: 'aashima.singh@irisregtech.com' }).select('+password').lean();
  expect(users).toHaveLength(1);
  expect(users[0]).toMatchObject({ authProvider: 'microsoft', isVerified: true, microsoftId: 'oid-aashima', lastLoginMethod: 'SSO', lastLoginProvider: 'microsoft' });
  expect(users[0].password).toBeUndefined();
  expect(await AuthIdentity.countDocuments({ user_id: users[0]._id, provider: 'microsoft', subject: 'oid-aashima', tenantId: TENANT })).toBe(1);
  expect((await events()).map((e) => [e.type, e.method, e.success])).toEqual([['ACCOUNT_CREATED', 'SSO', true], ['LOGIN_SUCCESS', 'SSO', true]]);
  const me = await validate(s);
  expect(me.status).toBe(200);
  expect(me.body.user).toMatchObject({ email: 'aashima.singh@irisregtech.com', lastLoginMethod: 'SSO', signInMethods: ['microsoft'] });
});

test('the same person via Microsoft and via password is ONE user; progress and Pre/Post history stay theirs', async () => {
  const local = await makeUser({ email: 'aashima.singh@irisregtech.com', department: dept });
  await UserCardProgress.create({ user_id: local._id, card_id: local._id, module_id: local._id, isCorrect: true });
  await AssessmentAttempt.create({ user_id: local._id, pathId: local._id, kind: 'pre', score: 1, maxScore: 2, percent: 50 });

  const sso = await ssoLogin(msClaims());
  expect((await validate(sso)).body.user.id).toBe(String(local._id));
  expect((await events({ type: 'ACCOUNT_LINKED' }))).toHaveLength(1);

  const pw = await localLogin('aashima.singh@irisregtech.com');
  expect(pw.res.status).toBe(200);
  expect(pw.res.body.user.id).toBe(String(local._id));
  expect(await User.countDocuments({ email: 'aashima.singh@irisregtech.com' })).toBe(1);
  expect((await User.findById(local._id).lean()).lastLoginMethod).toBe('LOCAL');
  const logins = await events({ type: 'LOGIN_SUCCESS' });
  expect(logins.map((e) => [String(e.user_id), e.method])).toEqual([[String(local._id), 'SSO'], [String(local._id), 'LOCAL']]);
  expect((await validate(pw)).body.user.signInMethods.sort()).toEqual(['local', 'microsoft']);

  // A repeat Microsoft sign-in is matched on the object id, even after the
  // mailbox was renamed.
  const renamed = await ssoLogin(msClaims({ email: 'aashima.s@irisregtech.com' }));
  expect((await validate(renamed)).body.user.id).toBe(String(local._id));
  expect(await User.countDocuments()).toBe(1);
  expect(await UserCardProgress.countDocuments({ user_id: local._id })).toBe(1);
  expect(await AssessmentAttempt.countDocuments({ user_id: local._id })).toBe(1);
});

test('accounts linked before AuthIdentity existed (User.microsoftId only) still match, without a duplicate', async () => {
  const legacy = await makeUser({ email: 'rudransh@irisregtech.com', department: dept });
  await User.updateOne({ _id: legacy._id }, { $set: { microsoftId: 'oid-rudransh' } });
  const s = await ssoLogin(msClaims({ oid: 'oid-rudransh', email: 'rudransh@irisregtech.com' }));
  expect((await validate(s)).body.user.id).toBe(String(legacy._id));
  expect(await AuthIdentity.countDocuments({ user_id: legacy._id })).toBe(1);
  expect(await events({ type: 'ACCOUNT_LINKED' })).toHaveLength(0);
});

test('linking cannot take over another account', async () => {
  const owner = await makeUser({ email: 'aashima.singh@irisregtech.com', department: dept });
  await ssoLogin(msClaims()); // owner's own Microsoft account linked

  // A different Microsoft account presenting the same email.
  const other = await ssoLogin(msClaims({ oid: 'oid-impostor' }));
  expect(other).toMatchObject({ token: null, error: 'identity_conflict' });
  // A guest from another organisation, a foreign tenant, a foreign domain.
  expect((await ssoLogin(msClaims({ oid: 'oid-guest', idp: 'https://sts.windows.net/99999999-0000-0000-0000-000000000000/' }))).error).toBe('not_member');
  expect((await ssoLogin(msClaims({ oid: 'oid-x', tid: '99999999-0000-0000-0000-000000000000' }))).error).toBe('domain_denied');
  expect((await ssoLogin(msClaims({ oid: 'oid-y', email: 'someone@gmail.com' }))).error).toBe('domain_denied');

  const failures = await events({ type: 'LOGIN_FAILED' });
  expect(failures.map((e) => e.reason)).toEqual(['identity_conflict', 'not_member', 'wrong_tenant', 'domain_denied']);
  failures.forEach((e) => expect(e).toMatchObject({ method: 'SSO', provider: 'microsoft', success: false }));
  expect(await User.countDocuments()).toBe(1);
  expect((await User.findById(owner._id).lean()).microsoftId).toBe('oid-aashima');
  expect(await AuthSession.countDocuments({ user_id: owner._id })).toBe(1);
});

test('an unverified sign-up of the same email is claimed by the Microsoft owner: its password is discarded', async () => {
  const reg = await request(app).post('/api/auth/register').send({ username: 'squatter', email: 'aashima.singh@irisregtech.com', password: 'attacker-pass-1', department: dept.code, captchaToken: 'ok' });
  expect(reg.status).toBe(200);
  const pending = await User.findOne({ email: 'aashima.singh@irisregtech.com' }).lean();
  expect(pending.isVerified).toBe(false);

  const s = await ssoLogin(msClaims());
  expect(s.error).toBeNull();
  const claimed = await User.findById(pending._id).select('+password').lean();
  expect(claimed).toMatchObject({ isVerified: true, microsoftId: 'oid-aashima', authProvider: 'microsoft' });
  expect(claimed.password).toBeUndefined();
  expect((await localLogin('aashima.singh@irisregtech.com', 'attacker-pass-1')).res.status).toBe(400);
  // Registering again can no longer replace the (now verified) account.
  const again = await request(app).post('/api/auth/register').send({ username: 'squatter2', email: 'aashima.singh@irisregtech.com', password: 'attacker-pass-2', department: dept.code, captchaToken: 'ok' });
  expect(again.status).toBe(400);
  expect(await User.countDocuments()).toBe(1);
});

test('failed password logins are recorded; a Microsoft-only account gets the same answer as a wrong password', async () => {
  const learner = await makeUser({ email: 'learner@irisregtech.com', department: dept });
  await ssoLogin(msClaims()); // creates a Microsoft-only account

  expect((await localLogin('learner@irisregtech.com', 'wrong-password')).res.status).toBe(400);
  expect((await localLogin('nobody@irisregtech.com', 'whatever-1')).res.status).toBe(400);
  const ssoOnly = await localLogin('aashima.singh@irisregtech.com', 'guessing-1');
  expect(ssoOnly.res.status).toBe(400);
  expect(ssoOnly.res.body.message).toBe('Invalid credentials');

  const failed = await events({ type: 'LOGIN_FAILED' });
  expect(failed.map((e) => [e.reason, e.method, e.user_id ? 'user' : 'none'])).toEqual([
    ['bad_password', 'LOCAL', 'user'], ['unknown_account', 'LOCAL', 'none'], ['sso_only', 'LOCAL', 'user'],
  ]);
  expect(failed[0].user_id.toString()).toBe(String(learner._id));
  expect(failed[1].email).toBe('nobody@irisregtech.com');
  expect(JSON.stringify(failed)).not.toMatch(/wrong-password|whatever-1|guessing-1/);
});

test('logout ends only that session; another device stays signed in', async () => {
  await makeUser({ email: 'learner@irisregtech.com', department: dept });
  const laptop = await localLogin('learner@irisregtech.com');
  const phone = await localLogin('learner@irisregtech.com');
  expect((await validate(laptop)).status).toBe(200);

  expect((await as(laptop, request(app).post('/api/auth/logout')).send({})).status).toBe(200);
  const after = await validate(laptop);
  expect(after.status).toBe(401);
  expect(after.body.code).toBe('session_revoked');
  expect((await validate(phone)).status).toBe(200);
  expect(await events({ type: 'LOGOUT' })).toHaveLength(1);
  expect(await AuthSession.findOne({ endReason: 'logout' }).lean()).toBeTruthy();
});

test('an expired session is refused as "session_expired" and recorded once', async () => {
  await makeUser({ email: 'learner@irisregtech.com', department: dept });
  const s = await localLogin('learner@irisregtech.com');
  const payload = jwt.decode(s.token);
  const expired = { ...s, token: jwt.sign({ user: payload.user, exp: Math.floor(Date.now() / 1000) - 60 }, process.env.JWT_SECRET) };
  for (let i = 0; i < 3; i++) {
    const res = await validate(expired);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('session_expired');
  }
  expect(await events({ type: 'SESSION_EXPIRED' })).toHaveLength(1);
  expect(await AuthSession.findOne({ sessionId: payload.user.sessionId }).lean()).toMatchObject({ endReason: 'expired' });
  // The browser's idle timer signs out as an expiry too.
  const fresh = await localLogin('learner@irisregtech.com');
  await as(fresh, request(app).post('/api/auth/logout')).send({ reason: 'idle' });
  expect((await events({ type: 'SESSION_EXPIRED' })).map((e) => e.reason)).toEqual([null, 'idle']);
});

test('password reset: never creates a password for a Microsoft-only account; a reset elsewhere keeps SSO working', async () => {
  await ssoLogin(msClaims()); // Microsoft-only
  const forgot = (email) => request(app).post('/api/auth/forgot-password').send({ email, captchaToken: 'ok' });
  const r1 = await forgot('aashima.singh@irisregtech.com');
  expect(r1.status).toBe(200);
  expect(sendEmail).not.toHaveBeenCalled();
  expect((await User.findOne({ email: 'aashima.singh@irisregtech.com' }).select('+resetPasswordToken').lean()).resetPasswordToken).toBeUndefined();
  expect((await events({ type: 'PASSWORD_RESET_REQUESTED' }))[0]).toMatchObject({ success: false, reason: 'sso_only' });

  // A password account that also uses Microsoft: reset works, every session
  // ends, and Microsoft sign-in still lands on the same account.
  const both = await makeUser({ email: 'rudransh@irisregtech.com', department: dept });
  const sso = await ssoLogin(msClaims({ oid: 'oid-rudransh', email: 'rudransh@irisregtech.com' }));
  expect((await forgot('rudransh@irisregtech.com')).status).toBe(200);
  const link = sendEmail.mock.calls[0][0].text.match(/reset-password\/([a-f0-9]+)/)[1];
  const reset = await request(app).put(`/api/auth/reset-password/${link}`).send({ password: 'brand-new-pass-1' });
  expect(reset.status).toBe(200);
  expect((await validate(sso)).status).toBe(401);
  expect((await localLogin('rudransh@irisregtech.com', 'brand-new-pass-1')).res.status).toBe(200);
  const again = await ssoLogin(msClaims({ oid: 'oid-rudransh', email: 'rudransh@irisregtech.com' }));
  expect((await validate(again)).body.user.id).toBe(String(both._id));
  expect(await events({ type: 'PASSWORD_RESET' })).toHaveLength(1);
});

test('changing the password keeps this device signed in and ends the others', async () => {
  await makeUser({ email: 'learner@irisregtech.com', department: dept });
  const here = await localLogin('learner@irisregtech.com');
  const there = await localLogin('learner@irisregtech.com');
  const res = await as(here, request(app).put('/api/auth/change-password')).send({ currentPassword: PASSWORD, newPassword: 'another-pass-2' });
  expect(res.status).toBe(200);
  const renewed = { token: res.body.token, cookie: cookieOf(res, 'orbit_bind') };
  expect((await validate(renewed)).status).toBe(200);
  expect((await validate(here)).status).toBe(401);
  expect((await validate(there)).status).toBe(401);
  expect(await events({ type: 'PASSWORD_CHANGED' })).toHaveLength(1);
  expect((await events({ type: 'SESSION_REVOKED' })).map((e) => e.reason)).toEqual(['password_changed', 'password_changed']);
  // A Microsoft-only account has no password to change.
  const sso = await ssoLogin(msClaims());
  expect((await as(sso, request(app).put('/api/auth/change-password')).send({ currentPassword: 'x', newPassword: 'abcdef1' })).status).toBe(400);
});

test('AUTH_SINGLE_SESSION=true: a new login ends the older one', async () => {
  process.env.AUTH_SINGLE_SESSION = 'true';
  await makeUser({ email: 'learner@irisregtech.com', department: dept });
  const first = await localLogin('learner@irisregtech.com');
  const second = await localLogin('learner@irisregtech.com');
  expect((await validate(first)).status).toBe(401);
  expect((await validate(second)).status).toBe(200);
  expect((await events({ type: 'SESSION_REVOKED' }))[0].reason).toBe('replaced');
});

test('admin sign-in activity: department-scoped, no secrets; admins can end a learner\'s sessions', async () => {
  const otherDept = await makeDepartment();
  const learner = await makeUser({ email: 'learner@irisregtech.com', department: dept });
  await makeUser({ email: 'outsider@irisregtech.com', department: otherDept });
  const peerAdmin = await makeUser({ email: 'peer.admin@irisregtech.com', department: dept, role: 'admin' });
  await makeUser({ email: 'admin@irisregtech.com', department: dept, role: 'admin' });
  await makeUser({ email: 'super@irisregtech.com', department: otherDept, role: 'superadmin' });
  const ls = await localLogin('learner@irisregtech.com');
  await localLogin('outsider@irisregtech.com');
  await localLogin('learner@irisregtech.com', 'wrong-password');
  const adm = await localLogin('admin@irisregtech.com');
  const sup = await localLogin('super@irisregtech.com');

  const list = await as(adm, request(app).get('/api/admin/auth/events'));
  expect(list.status).toBe(200);
  const emails = list.body.data.map((r) => r.email);
  expect(emails).toContain('learner@irisregtech.com');
  expect(emails).not.toContain('outsider@irisregtech.com');
  expect(list.body.data[0]).not.toHaveProperty('ip');
  expect(JSON.stringify(list.body)).not.toMatch(/password123|wrong-password|"token"|sessionId|userAgent/);
  expect(list.body.summary).toMatchObject({ localLogins: 2, failed: 1 });
  const failedOnly = await as(adm, request(app).get('/api/admin/auth/events?result=failure'));
  expect(failedOnly.body.data.map((r) => [r.email, r.type, r.reason])).toEqual([['learner@irisregtech.com', 'LOGIN_FAILED', 'bad_password']]);

  const all = await as(sup, request(app).get('/api/admin/auth/events?method=LOCAL'));
  expect(all.body.data.map((r) => r.email)).toContain('outsider@irisregtech.com');
  expect(all.body.data[0]).toHaveProperty('ip');
  const csv = await as(sup, request(app).get('/api/admin/auth/events?format=csv'));
  expect(csv.text.split('\r\n')[0]).toBe('Time (UTC),User,Email,Method,Provider,Event,Result,Reason,Device,IP');

  const sessions = await as(adm, request(app).get(`/api/admin/auth/users/${learner._id}/sessions`));
  expect(sessions.body.data).toMatchObject({ lastLoginMethod: 'LOCAL', signInMethods: ['local'] });
  expect(sessions.body.data.sessions).toHaveLength(1);
  expect(sessions.body.data.sessions[0].ref).toHaveLength(6);

  expect((await as(adm, request(app).post(`/api/admin/auth/users/${peerAdmin._id}/sessions/revoke`))).status).toBe(403);
  const revoke = await as(adm, request(app).post(`/api/admin/auth/users/${learner._id}/sessions/revoke`));
  expect(revoke.body.data.ended).toBe(1);
  expect((await validate(ls)).body.code).toBe('session_revoked');
  const ev = (await events({ type: 'SESSION_REVOKED' }))[0];
  expect(ev).toMatchObject({ reason: 'revoked' });
  expect(String(ev.actor_id)).toBe(String((await User.findOne({ email: 'admin@irisregtech.com' }))._id));

  // Roles still apply: a learner can't open the admin view.
  const fresh = await localLogin('learner@irisregtech.com');
  expect((await as(fresh, request(app).get('/api/admin/auth/events'))).status).toBe(403);
});
