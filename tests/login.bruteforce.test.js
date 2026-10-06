// tests/login.bruteforce.test.js
//
// Regression coverage for the VAPT "Insufficient Protection Against Brute
// Force Attacks" finding (CWE-307), through the REAL router + REAL login
// logic (authRoutes.js), not a mock of the app's own code — only the
// outbound call to Google's reCAPTCHA siteverify API is mocked, since that's
// a network dependency this endpoint calls unconditionally on every request
// (see middleware/verifyCaptcha.js) and a unit/integration test shouldn't
// depend on live network access or a real CAPTCHA solve to prove the
// application's OWN throttling logic works.
//
// IMPORTANT CONTEXT for anyone re-reading this file: the previous version of
// this suite sent no `captchaToken` at all. Since POST /login is wired as
// `[loginLimiter, verifyCaptcha, <handler>]`, every request was rejected by
// verifyCaptcha with 400 "CAPTCHA verification is required" *before ever
// reaching the password/lockout logic* — which is why the old assertions
// about failedLoginAttempts/lockUntil failed (nothing ever touched them).
// That was a test bug, not a missing lockout feature: the account-lockout
// code was already present and correct in authRoutes.js, just unreachable
// from this test. Fixed here by mocking the CAPTCHA call to "pass", the same
// way an attacker would need to defeat CAPTCHA before ever reaching the
// password check in the first place.
require('dotenv').config(); // authRoutes.js pulls in msalClient, which needs
// real Microsoft SSO env vars just to construct at import time — mirrors
// how server.js boots in production instead of stubbing that dependency out.

const express = require('express');
const request = require('supertest');
const cookieParser = require('cookie-parser');
const axios = require('axios');
const { connect, closeDatabase, clearCollections } = require('./setup/inMemoryMongo');
const { makeUser } = require('./setup/fixtures');
const User = require('../src/models/User');
const crypto = require('crypto');

// Credentials are generated per run — no literal passwords in source.
const randomSecret = (tag) => `${tag}-${crypto.randomBytes(9).toString('base64url')}-9a`;
const GOOD_PW = randomSecret('Good');
const OTHER_GOOD_PW = randomSecret('Other');
const BAD_PW = randomSecret('Bad');
const GUESSES = [randomSecret('G1'), randomSecret('G2'), randomSecret('G3'), GOOD_PW, randomSecret('G5')];

jest.mock('axios');

jest.setTimeout(30000);

process.env.JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

let app;
let loginLimiterStore;

// A "solved" CAPTCHA — the shape every legitimate login request carries.
// Individual tests override axios.post's mock to simulate Google rejecting
// a token (expired/already-used/absent) where that distinction matters.
const SOLVED_CAPTCHA = { captchaToken: 'valid-test-token' };

function loginReq(body) {
  return request(app).post('/api/auth/login').send(body);
}

beforeAll(async () => {
  await connect();
  const authRoutes = require('../src/routes/authRoutes');
  ({ loginLimiterStore } = require('../src/middleware/rateLimiters'));
  app = express();
  app.set('trust proxy', 1); // as server.js: req.secure follows X-Forwarded-Proto
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRoutes);
});

afterAll(async () => {
  await closeDatabase();
});

beforeEach(() => {
  axios.post.mockResolvedValue({ data: { success: true } });
});

afterEach(async () => {
  await clearCollections();
  // The IP-based loginLimiter is a process-wide singleton keyed by source
  // IP — every request in this file originates from the same loopback
  // address, so without a reset each test would inherit the request count
  // left behind by the previous one and could trip 429 unexpectedly.
  loginLimiterStore.resetAll();
  jest.clearAllMocks();
});

// VAPT 7.6 (CWE-319): in production, auth requests must arrive over HTTPS
// as reported by the trusted proxy — refused before anything is checked.
test('production auth requests require HTTPS as reported by the trusted proxy', async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const insecure = await loginReq({ email: 'test@example.com', password: BAD_PW });
    expect(insecure.status).toBe(426);
    expect(insecure.body.message).toMatch(/HTTPS is required/i);
    expect(axios.post).not.toHaveBeenCalled();

    const secure = await request(app)
      .post('/api/auth/login')
      .set('X-Forwarded-Proto', 'https')
      .send({ email: 'test@example.com', password: BAD_PW });
    expect(secure.status).toBe(400); // past the HTTPS check, stopped at the CAPTCHA
    expect(secure.body.message).toMatch(/CAPTCHA/i);
  } finally {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  }
});

describe('POST /api/auth/login — CAPTCHA is mandatory on every attempt', () => {
  test('a request with no captchaToken is rejected before the password is even checked — even with the CORRECT password', async () => {
    const user = await makeUser({ password: GOOD_PW });
    const res = await loginReq({ email: user.email, password: GOOD_PW });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/CAPTCHA/i);
    expect(axios.post).not.toHaveBeenCalled(); // short-circuited before even calling Google

    const fresh = await User.findById(user._id).select('+failedLoginAttempts');
    expect(fresh.failedLoginAttempts).toBe(0); // never reached the counter
  });

  test('a token Google rejects (expired/already-used/invalid) is treated as no CAPTCHA at all', async () => {
    axios.post.mockResolvedValue({ data: { success: false } });
    const user = await makeUser({ password: GOOD_PW });

    const res = await loginReq({ ...SOLVED_CAPTCHA, email: user.email, password: GOOD_PW });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/CAPTCHA/i);
  });

  // Directly reproduces the reported PoC's methodology: Burp Intruder holds
  // every field EXCEPT the password payload position constant — including
  // the captchaToken, since the tester's own instructions only mention
  // configuring the password field as the payload position. A real
  // single-use reCAPTCHA token is consumed by Google on its first
  // successful verification and rejected on every subsequent submission —
  // modeled here by the mock only succeeding once, matching Google's actual
  // server-side single-use enforcement.
  test('replaying the SAME captchaToken across an Intruder-style sweep only ever lets ONE guess through', async () => {
    let used = false;
    axios.post.mockImplementation(async () => {
      if (used) return { data: { success: false } }; // Google: token already consumed
      used = true;
      return { data: { success: true } };
    });

    const user = await makeUser({ password: GOOD_PW });
    const wordlist = GUESSES;

    const results = [];
    for (const password of wordlist) {
      const res = await loginReq({ ...SOLVED_CAPTCHA, email: user.email, password });
      results.push(res.status);
    }

    // Exactly one request in the whole sweep ever reached real password
    // verification (the first) — every other guess, correct or not, was
    // blocked at the CAPTCHA gate before the password was even looked at.
    expect(results.every((status) => status === 400)).toBe(true);
    expect(axios.post).toHaveBeenCalledTimes(wordlist.length);
    const fresh = await User.findById(user._id).select('+failedLoginAttempts');
    // Only the FIRST guess ('password1', wrong) could have incremented the
    // counter; all later ones never got past verifyCaptcha.
    expect(fresh.failedLoginAttempts).toBe(1);
  });
});

describe('POST /api/auth/login — per-account lockout (CAPTCHA satisfied)', () => {
  test('correct credentials succeed under normal conditions', async () => {
    const user = await makeUser({ password: GOOD_PW });
    const res = await loginReq({ ...SOLVED_CAPTCHA, email: user.email, password: GOOD_PW });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    // The session-binding cookie is only sent to the API, not every page.
    expect(res.headers['set-cookie'].some((cookie) => cookie.startsWith('orbit_bind=') && cookie.includes('Path=/api;'))).toBe(true);
  });

  test('a single incorrect password is rejected without any lockout side effect', async () => {
    const user = await makeUser({ password: GOOD_PW });
    const res = await loginReq({ ...SOLVED_CAPTCHA, email: user.email, password: BAD_PW });
    expect(res.status).toBe(400);

    const fresh = await User.findById(user._id).select('+failedLoginAttempts +lockUntil');
    expect(fresh.failedLoginAttempts).toBe(1);
    expect(fresh.lockUntil).toBeNull();
  });

  test('a small number of failed attempts (below threshold) behaves normally — no lockout yet', async () => {
    const user = await makeUser({ password: GOOD_PW });
    for (let i = 0; i < 3; i++) {
      const res = await loginReq({ ...SOLVED_CAPTCHA, email: user.email, password: BAD_PW });
      expect(res.status).toBe(400);
    }
    const fresh = await User.findById(user._id).select('+failedLoginAttempts +lockUntil');
    expect(fresh.failedLoginAttempts).toBe(3);
    expect(fresh.lockUntil).toBeNull();

    // The account isn't locked yet — the correct password still works.
    const goodRes = await loginReq({ ...SOLVED_CAPTCHA, email: user.email, password: GOOD_PW });
    expect(goodRes.status).toBe(200);
  });

  test('locks the account after 5 consecutive wrong passwords, and rejects even the correct password while locked', async () => {
    const user = await makeUser({ password: GOOD_PW });

    for (let i = 0; i < 5; i++) {
      const res = await loginReq({ ...SOLVED_CAPTCHA, email: user.email, password: BAD_PW });
      expect(res.status).toBe(400);
    }

    const afterFiveFails = await User.findById(user._id).select('+failedLoginAttempts +lockUntil');
    expect(afterFiveFails.lockUntil).not.toBeNull();
    expect(afterFiveFails.lockUntil.getTime()).toBeGreaterThan(Date.now());
    // Counter resets once locked — the lock itself, not a growing counter,
    // is what blocks further attempts for the next lockout window.
    expect(afterFiveFails.failedLoginAttempts).toBe(0);

    // The account's real, correct password must still be rejected while locked.
    const lockedAttempt = await loginReq({ ...SOLVED_CAPTCHA, email: user.email, password: GOOD_PW });
    expect(lockedAttempt.status).toBe(423);

    // The lockout must not be indefinite — it carries a bounded expiry.
    const lockDurationMs = afterFiveFails.lockUntil.getTime() - Date.now();
    expect(lockDurationMs).toBeLessThanOrEqual(15 * 60 * 1000 + 1000);
  }, 20000);

  test('the lockout expires on its own — a correct password succeeds again once it has passed', async () => {
    const user = await makeUser({ password: GOOD_PW });
    // Simulate having already tripped the lock and the window having
    // elapsed, rather than waiting 15 real minutes in a test.
    await User.updateOne({ _id: user._id }, { $set: { lockUntil: new Date(Date.now() - 1000), failedLoginAttempts: 0 } });

    const res = await loginReq({ ...SOLVED_CAPTCHA, email: user.email, password: GOOD_PW });
    expect(res.status).toBe(200);
  });

  test('a successful login resets any prior failed-attempt count', async () => {
    const user = await makeUser({ password: GOOD_PW });

    await loginReq({ ...SOLVED_CAPTCHA, email: user.email, password: BAD_PW });
    await loginReq({ ...SOLVED_CAPTCHA, email: user.email, password: BAD_PW });

    const midway = await User.findById(user._id).select('+failedLoginAttempts');
    expect(midway.failedLoginAttempts).toBe(2);

    const goodRes = await loginReq({ ...SOLVED_CAPTCHA, email: user.email, password: GOOD_PW });
    expect(goodRes.status).toBe(200);

    const afterSuccess = await User.findById(user._id).select('+failedLoginAttempts +lockUntil');
    expect(afterSuccess.failedLoginAttempts).toBe(0);
    expect(afterSuccess.lockUntil).toBeNull();
  }, 15000);

  test('a nonexistent email is rejected without touching any account lockout state', async () => {
    const res = await loginReq({ ...SOLVED_CAPTCHA, email: 'nobody@irisregtech.com', password: BAD_PW });
    expect(res.status).toBe(400);
  });

  test('does not reveal account existence: wrong password vs. nonexistent email look identical', async () => {
    const user = await makeUser({ password: GOOD_PW });
    const wrongPwRes = await loginReq({ ...SOLVED_CAPTCHA, email: user.email, password: BAD_PW });
    const noAccountRes = await loginReq({ ...SOLVED_CAPTCHA, email: 'nobody@irisregtech.com', password: BAD_PW });

    expect(wrongPwRes.status).toBe(noAccountRes.status);
    expect(wrongPwRes.body.message).toBe(noAccountRes.body.message);
  });

  test('the lockout is temporary, not permanent — an attacker cannot permanently deny the real owner access', async () => {
    const user = await makeUser({ password: GOOD_PW });
    for (let i = 0; i < 5; i++) {
      await loginReq({ ...SOLVED_CAPTCHA, email: user.email, password: BAD_PW });
    }
    const locked = await User.findById(user._id).select('+lockUntil');
    expect(locked.lockUntil).not.toBeNull();
    // Bounded, not null/Infinity — i.e. the record itself carries a
    // concrete expiry rather than an "account disabled" style flag.
    expect(Number.isFinite(locked.lockUntil.getTime())).toBe(true);
  }, 20000);

  test('two accounts are isolated — locking one does not affect, and is not affected by, the other', async () => {
    const userA = await makeUser({ password: GOOD_PW });
    const userB = await makeUser({ password: OTHER_GOOD_PW });

    for (let i = 0; i < 5; i++) {
      await loginReq({ ...SOLVED_CAPTCHA, email: userA.email, password: BAD_PW });
    }

    const freshA = await User.findById(userA._id).select('+lockUntil');
    const freshB = await User.findById(userB._id).select('+lockUntil +failedLoginAttempts');
    expect(freshA.lockUntil).not.toBeNull();
    expect(freshB.lockUntil).toBeNull();
    expect(freshB.failedLoginAttempts).toBe(0);

    // B's own correct password still works — unaffected by A's lockout.
    const resB = await loginReq({ ...SOLVED_CAPTCHA, email: userB.email, password: OTHER_GOOD_PW });
    expect(resB.status).toBe(200);
  }, 20000);

  test('concurrent failed attempts cannot bypass the lockout threshold via a race condition', async () => {
    const user = await makeUser({ password: GOOD_PW });

    // 8 simultaneous wrong-password requests against a 5-attempt threshold —
    // if the counter increment weren't atomic, more than 5 "wrong password"
    // responses could land before the lock takes effect and the true count
    // could drift. MongoDB's $inc (used in authRoutes.js) is atomic per
    // document, so each request gets a distinct, race-free increment.
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () => loginReq({ ...SOLVED_CAPTCHA, email: user.email, password: BAD_PW })),
    );

    attempts.forEach((res) => expect([400, 423]).toContain(res.status));

    const fresh = await User.findById(user._id).select('+failedLoginAttempts +lockUntil');
    // 8 concurrent atomic $inc's against a 5-attempt threshold guarantee the
    // account ends up locked — the exact final counter value can depend on
    // write ordering between the 4 non-crossing increments and the
    // lock-triggering reset, so only the security-relevant invariant (locked,
    // never re-armed past the threshold) is asserted, not one exact number.
    expect(fresh.lockUntil).not.toBeNull();
    expect(fresh.lockUntil.getTime()).toBeGreaterThan(Date.now());
    expect(fresh.failedLoginAttempts).toBeLessThan(5);

    // Correct password must still be rejected — no race let a guess slip
    // through as authenticated before/while the lock was being set.
    const afterRace = await loginReq({ ...SOLVED_CAPTCHA, email: user.email, password: GOOD_PW });
    expect(afterRace.status).toBe(423);
  }, 20000);
});

describe('POST /api/auth/login — IP-based rate limiting (complements the per-account lockout)', () => {
  test('the 11th login request from one source within the window is rate-limited with 429', async () => {
    const user = await makeUser({ password: GOOD_PW });

    let lastRes;
    for (let i = 0; i < 11; i++) {
      lastRes = await loginReq({ ...SOLVED_CAPTCHA, email: user.email, password: BAD_PW });
    }

    expect(lastRes.status).toBe(429);
    expect(lastRes.headers['retry-after'] ?? lastRes.headers['ratelimit-reset']).toBeDefined();
  }, 30000);

  test('rotating the target username from the same source does not bypass the IP-based limit', async () => {
    // A credential-stuffing sweep across many DIFFERENT accounts from one
    // source must still trip the IP limiter — it isn't scoped per-account.
    const usernames = Array.from({ length: 11 }, (_, i) => `nonexistent${i}@irisregtech.com`);

    let lastRes;
    for (const email of usernames) {
      lastRes = await loginReq({ ...SOLVED_CAPTCHA, email, password: BAD_PW });
    }

    expect(lastRes.status).toBe(429);
  }, 30000);
});
