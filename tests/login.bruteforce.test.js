// tests/login.bruteforce.test.js
//
// Regression coverage for the VAPT "Insufficient Protection Against Brute
// Force Attacks" finding (CWE-307): POST /api/auth/login must lock an
// account after repeated wrong passwords, and reject even a CORRECT
// password while locked — through the REAL router + REAL auth logic, not a
// mock, so a future refactor that quietly drops the lockout check fails
// this test instead of shipping.
require('dotenv').config(); // authRoutes.js pulls in msalClient, which needs
// real Microsoft SSO env vars just to construct at import time — mirrors
// how server.js boots in production instead of stubbing that dependency out.

const express = require('express');
const request = require('supertest');
const cookieParser = require('cookie-parser');
const { connect, closeDatabase, clearCollections } = require('./setup/inMemoryMongo');
const { makeUser } = require('./setup/fixtures');
const User = require('../src/models/User');

jest.setTimeout(30000);

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret-do-not-use-in-prod';

let app;

beforeAll(async () => {
  await connect();
  const authRoutes = require('../src/routes/authRoutes');
  app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRoutes);
});

afterAll(async () => {
  await closeDatabase();
});

afterEach(async () => {
  await clearCollections();
});

describe('POST /api/auth/login brute-force protection', () => {
  test('locks the account after 5 consecutive wrong passwords, and rejects even the correct password while locked', async () => {
    const user = await makeUser({ password: 'CorrectHorseBattery1' });

    let lastRes;
    for (let i = 0; i < 5; i++) {
      lastRes = await request(app)
        .post('/api/auth/login')
        .send({ email: user.email, password: 'WrongPassword!' });
      expect(lastRes.status).toBe(400);
    }

    const afterFiveFails = await User.findById(user._id).select('+failedLoginAttempts +lockUntil');
    expect(afterFiveFails.lockUntil).not.toBeNull();
    expect(afterFiveFails.lockUntil.getTime()).toBeGreaterThan(Date.now());
    // Counter resets once locked — the lock itself, not a growing counter, is
    // what blocks further attempts for the next MAX_FAILED_LOGIN_ATTEMPTS window.
    expect(afterFiveFails.failedLoginAttempts).toBe(0);

    // The account's real, correct password must still be rejected while locked.
    const lockedAttempt = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: 'CorrectHorseBattery1' });
    expect(lockedAttempt.status).toBe(423);
  }, 20000);

  test('a successful login resets any prior failed-attempt count', async () => {
    const user = await makeUser({ password: 'CorrectHorseBattery1' });

    await request(app).post('/api/auth/login').send({ email: user.email, password: 'nope' });
    await request(app).post('/api/auth/login').send({ email: user.email, password: 'nope' });

    const midway = await User.findById(user._id).select('+failedLoginAttempts');
    expect(midway.failedLoginAttempts).toBe(2);

    const goodRes = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: 'CorrectHorseBattery1' });
    expect(goodRes.status).toBe(200);

    const afterSuccess = await User.findById(user._id).select('+failedLoginAttempts +lockUntil');
    expect(afterSuccess.failedLoginAttempts).toBe(0);
    expect(afterSuccess.lockUntil).toBeNull();
  }, 15000);

  test('a nonexistent email is rejected without touching any account lockout state', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@irisregtech.com', password: 'whatever' });
    expect(res.status).toBe(400);
  });
});
