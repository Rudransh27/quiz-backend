// tests/setup/fixtures.js
// Minimal, valid fixture builders for the real Mongoose models this bug
// touches. Uses the real User/Department models (not stand-ins), so every
// schema rule (email domain whitelist, required department, etc.) is
// exercised exactly as production traffic would hit it.
const User = require('../../src/models/User');
const Department = require('../../src/models/Department');

let counter = 0;

async function makeDepartment(overrides = {}) {
  counter += 1;
  return Department.create({
    name: overrides.name || `Test Dept ${counter}`,
    code: overrides.code || `testdept${counter}`,
  });
}

async function makeUser(overrides = {}) {
  // Snapshot the counter synchronously, BEFORE the department await below —
  // reading the shared `counter` again after an await let concurrent
  // makeUser() calls (e.g. Promise.all in a test) interleave and land on
  // the same value, producing duplicate emails. Capturing it up front makes
  // each call's identifier stable regardless of what else races around it.
  counter += 1;
  const myId = counter;
  const department = overrides.department || (await makeDepartment());
  return User.create({
    username: overrides.username || `testuser${myId}`,
    email: overrides.email || `testuser${myId}@irisregtech.com`,
    password: overrides.password || 'password123',
    role: overrides.role || 'user',
    department: department._id,
    isVerified: true,
    currentStreak: overrides.currentStreak ?? 0,
    longestStreak: overrides.longestStreak ?? 0,
    lastActiveDate: overrides.lastActiveDate ?? null,
    engagementHistory: overrides.engagementHistory ?? [],
  });
}

// Builds a mock Express (req, res) pair shaped exactly like what auth.js's
// middleware attaches to req.user, and captures whatever the controller
// sends back via res.status().json() so tests can assert on it directly.
function mockReqRes({ user, body = {} } = {}) {
  const req = {
    user: { id: user._id, role: user.role },
    body,
  };
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return { req, res };
}

function toDateString(date) {
  return date.toISOString().split('T')[0];
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

module.exports = { makeDepartment, makeUser, mockReqRes, toDateString, daysAgo };
