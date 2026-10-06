// tests/authz.privilege-escalation.test.js
//
// Security-focused verification for the reported finding "Improper
// Authorization Leading to Vertical Privilege Escalation" (a Superadmin JWT
// captured and replayed was reported as proof a Learner can obtain Superadmin
// access). Exercises the REAL, unmodified auth.js / admin.js / superadmin.js
// middleware and route wiring (regionRoutes.js, progressRoutes.js) over real
// HTTP, against a real in-memory MongoDB — same integration style as
// streak.http.test.js.
//
// What this suite proves:
//   1. Authorization is enforced server-side, independent of any client-
//      supplied role claim — auth.js re-derives req.user.role from the DB
//      on every request, so a JWT is never trusted for role on its own.
//   2. A Learner (role 'user') cannot reach Admin- or Superadmin-only
//      routes, even holding a validly-signed token, even if that token's
//      own payload *claims* role 'superadmin' (the scenario the report's
//      PoC gestures at) — because the claim is discarded and the DB role
//      is used instead.
//   3. A genuine Superadmin token continues to work correctly (the fix must
//      not break legitimate Superadmin access).
//   4. Tampering with a token's payload (without the secret) invalidates
//      its signature and is rejected.
//   5. Expired tokens are rejected.
//   6. A 403 response never leaks the protected payload.
//   7. Cross-department IDOR is blocked for department-scoped Admin routes.
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const { connect, closeDatabase, clearCollections } = require('./setup/inMemoryMongo');
const { makeUser, makeDepartment } = require('./setup/fixtures');

jest.setTimeout(30000);

process.env.JWT_SECRET = process.env.JWT_SECRET || require('crypto').randomBytes(32).toString('hex');

let app;

// Mirrors the real login flow's session-binding cookie (see authRoutes.js's
// issueBindingCookie / auth.js's binding check) so these requests look like
// genuine, unmodified traffic through the real middleware chain.
function signToken(claims, opts = {}) {
  return jwt.sign({ user: claims }, process.env.JWT_SECRET, { expiresIn: '1h', ...opts });
}

function bindingFor(user) {
  const bindingSecret = crypto.randomBytes(32).toString('hex');
  const bh = crypto.createHash('sha256').update(bindingSecret).digest('hex');
  return { bh, cookie: `orbit_bind=${bindingSecret}` };
}

// Builds a token/cookie pair exactly as a real login would for this user —
// role in the payload is whatever the caller passes, letting tests simulate
// a forged/stale claim while the DB record stays the source of truth.
function authForClaims(user, claimOverrides = {}) {
  const { bh, cookie } = bindingFor(user);
  const token = signToken({ id: user._id.toString(), role: user.role, bh, sessionId: crypto.randomUUID(), ...claimOverrides });
  return { token, cookie };
}

function authed(req, user, claimOverrides = {}) {
  const { token, cookie } = authForClaims(user, claimOverrides);
  return req.set('Authorization', `Bearer ${token}`).set('Cookie', cookie);
}

beforeAll(async () => {
  await connect();
  const regionRoutes = require('../src/routes/regionRoutes');
  const progressRoutes = require('../src/routes/progressRoutes');
  app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/regions', regionRoutes);
  app.use('/api/progress', progressRoutes);
});

afterAll(async () => {
  await closeDatabase();
});

afterEach(async () => {
  await clearCollections();
});

describe('Vertical privilege escalation report: authorization is enforced server-side', () => {
  test('unauthenticated request to a protected endpoint is rejected with 401', async () => {
    const res = await request(app).get('/api/progress/streak');
    expect(res.status).toBe(401);
  });

  test('a Learner can use Learner-authorized functionality (their own streak)', async () => {
    const learner = await makeUser({ role: 'user' });
    const res = await authed(request(app).get('/api/progress/streak'), learner);
    expect(res.status).toBe(200);
  });

  test('a Learner cannot reach Admin-only functionality', async () => {
    const learner = await makeUser({ role: 'user' });
    const res = await authed(request(app).get('/api/progress/admin/users'), learner);
    expect(res.status).toBe(403);
    expect(res.body.data).toBeUndefined();
    expect(res.body.users).toBeUndefined();
  });

  test('a Learner cannot reach Superadmin-only functionality (create region)', async () => {
    const learner = await makeUser({ role: 'user' });
    const res = await authed(
      request(app).post('/api/regions').send({ name: 'Escalated Region' }),
      learner,
    );
    expect(res.status).toBe(403);
    expect(res.body.data).toBeUndefined();
  });

  test('a Department Admin cannot reach Superadmin-only functionality', async () => {
    const dept = await makeDepartment();
    const deptAdmin = await makeUser({ role: 'admin', department: dept });
    const res = await authed(
      request(app).post('/api/regions').send({ name: 'Escalated Region 2' }),
      deptAdmin,
    );
    expect(res.status).toBe(403);
  });

  test('a genuine Superadmin token grants Superadmin access (legitimate use keeps working)', async () => {
    const superadmin = await makeUser({ role: 'superadmin' });
    const res = await authed(
      request(app).post('/api/regions').send({ name: 'APAC', code: 'APAC' }),
      superadmin,
    );
    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe('APAC');
  });

  test('a Learner cannot escalate by forging a "superadmin" role claim inside an otherwise validly-signed token', async () => {
    // Simulates the report's scenario: an Authorization header carrying a
    // token that *asserts* superadmin. Here the token is signed for a real
    // account whose actual DB role is 'user' — proving the claim alone,
    // even with a technically valid signature, is never enough: auth.js
    // discards it and re-reads role from the database on every request.
    const learner = await makeUser({ role: 'user' });
    const res = await authed(
      request(app).post('/api/regions').send({ name: 'Forged Claim Region' }),
      learner,
      { role: 'superadmin' },
    );
    expect(res.status).toBe(403);
  });

  test('tampering with a signed token\'s payload invalidates the signature and is rejected', async () => {
    const learner = await makeUser({ role: 'user' });
    const { token, cookie } = authForClaims(learner);

    const [headerB64, payloadB64, sig] = token.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    payload.user.role = 'superadmin';
    const tamperedPayloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const tamperedToken = `${headerB64}.${tamperedPayloadB64}.${sig}`;

    const res = await request(app)
      .post('/api/regions')
      .set('Authorization', `Bearer ${tamperedToken}`)
      .set('Cookie', cookie)
      .send({ name: 'Tampered Region' });

    expect(res.status).toBe(401);
  });

  test('an expired token is rejected even for a real Superadmin account', async () => {
    const superadmin = await makeUser({ role: 'superadmin' });
    const { bh, cookie } = bindingFor(superadmin);
    const expiredToken = signToken(
      { id: superadmin._id.toString(), role: superadmin.role, bh },
      { expiresIn: '-10s' },
    );

    const res = await request(app)
      .post('/api/regions')
      .set('Authorization', `Bearer ${expiredToken}`)
      .set('Cookie', cookie)
      .send({ name: 'Expired Token Region' });

    expect(res.status).toBe(401);
  });

  test('a token with no algorithm-signed body ("none" alg) is rejected', async () => {
    const learner = await makeUser({ role: 'user' });
    const { bh, cookie } = bindingFor(learner);
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ user: { id: learner._id.toString(), role: 'superadmin', bh } }),
    ).toString('base64url');
    const noneAlgToken = `${header}.${payload}.`;

    const res = await request(app)
      .post('/api/regions')
      .set('Authorization', `Bearer ${noneAlgToken}`)
      .set('Cookie', cookie)
      .send({ name: 'None Alg Region' });

    expect(res.status).toBe(401);
  });

  test('IDOR: a Department Admin cannot read another department\'s user analytics by guessing a userId', async () => {
    const deptA = await makeDepartment();
    const deptB = await makeDepartment();
    const adminA = await makeUser({ role: 'admin', department: deptA });
    const userInDeptB = await makeUser({ role: 'user', department: deptB });

    const res = await authed(
      request(app).get(`/api/progress/admin/user/${userInDeptB._id}`),
      adminA,
    );
    expect(res.status).toBe(403);
  });

  test('a Department Admin CAN read a user analytics record inside their own department', async () => {
    const deptA = await makeDepartment();
    const adminA = await makeUser({ role: 'admin', department: deptA });
    const userInDeptA = await makeUser({ role: 'user', department: deptA });

    const res = await authed(
      request(app).get(`/api/progress/admin/user/${userInDeptA._id}`),
      adminA,
    );
    expect(res.status).toBe(200);
  });
});
