// tests/streak.isolation.test.js
//
// Regression suite for the "streak updates leaked across users" report.
// Calls the REAL controller functions (progressController.verifyDailyStreak /
// getMyStreak) against a REAL MongoDB — an ephemeral in-memory instance via
// mongodb-memory-server, not a mock of Mongoose. That distinction matters:
// a mocked Model only proves "the code called the function we expected" —
// it can't catch a filter that's subtly wrong (e.g. an accidental {} that
// matches every document) the way an actual database execution can. Express
// itself isn't involved here — req/res are minimal hand-built stand-ins
// (see mockReqRes) shaped exactly like what auth.js's real middleware
// attaches to req.user, so the controller runs completely unmodified.
const { connect, closeDatabase, clearCollections } = require('./setup/inMemoryMongo');
const { makeUser, mockReqRes, toDateString, daysAgo } = require('./setup/fixtures');
const User = require('../src/models/User');
const progressController = require('../src/controllers/progressController');

jest.setTimeout(30000);

beforeAll(async () => {
  await connect();
});

afterAll(async () => {
  await closeDatabase();
});

afterEach(async () => {
  await clearCollections();
});

// =========================================================================
// SCENARIO 1 — Multi-user isolation
// =========================================================================
describe('Scenario 1: Multi-user isolation', () => {
  test("User A completing an activity does not change User B's streak", async () => {
    const userA = await makeUser({ username: 'userA' });
    const userB = await makeUser({ username: 'userB' });

    // Baseline — both start identical and independent.
    expect(userA.currentStreak).toBe(0);
    expect(userB.currentStreak).toBe(0);

    // User A completes a daily-read action.
    const { req, res } = mockReqRes({ user: userA, body: { actionType: 'daily_read' } });
    await progressController.verifyDailyStreak(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.currentStreak).toBe(1);

    // The real assertion: re-fetch BOTH users fresh from the database —
    // not from in-memory JS references — and confirm only A changed.
    const freshA = await User.findById(userA._id);
    const freshB = await User.findById(userB._id);

    expect(freshA.currentStreak).toBe(1);
    expect(freshB.currentStreak).toBe(0);
    expect(freshB.lastActiveDate).toBeNull();
    expect(freshB.engagementHistory).toHaveLength(0);
  });

  test('scales to N bystanders — only the acting user is ever modified', async () => {
    const users = await Promise.all(
      Array.from({ length: 5 }, (_, i) => makeUser({ username: `bystander${i}` }))
    );
    const actingUser = users[2];

    const { req, res } = mockReqRes({ user: actingUser, body: { actionType: 'module_progress' } });
    await progressController.verifyDailyStreak(req, res);
    expect(res.body.currentStreak).toBe(1);

    const allUsers = await User.find({});
    expect(allUsers).toHaveLength(5);
    for (const u of allUsers) {
      if (u._id.toString() === actingUser._id.toString()) {
        expect(u.currentStreak).toBe(1);
      } else {
        expect(u.currentStreak).toBe(0);
      }
    }
  });

  test('two users acting on the SAME day each get their own independent streak of 1', async () => {
    const userA = await makeUser({ username: 'userA' });
    const userB = await makeUser({ username: 'userB' });

    const callA = mockReqRes({ user: userA, body: { actionType: 'daily_read' } });
    const callB = mockReqRes({ user: userB, body: { actionType: 'idea_submission' } });

    await progressController.verifyDailyStreak(callA.req, callA.res);
    await progressController.verifyDailyStreak(callB.req, callB.res);

    expect(callA.res.body.currentStreak).toBe(1);
    expect(callB.res.body.currentStreak).toBe(1);

    // Different action types recorded on each user's OWN document, not merged.
    const freshA = await User.findById(userA._id);
    const freshB = await User.findById(userB._id);
    expect(freshA.engagementHistory[0].actions).toEqual(['daily_read']);
    expect(freshB.engagementHistory[0].actions).toEqual(['idea_submission']);
  });
});

// =========================================================================
// SCENARIO 2 — Consecutive-day logic, correctness AND isolation together
// =========================================================================
describe('Scenario 2: Consecutive days logic', () => {
  test('streak continues (+1) when lastActiveDate was yesterday', async () => {
    const yesterday = toDateString(daysAgo(1));
    const user = await makeUser({ currentStreak: 5, longestStreak: 5, lastActiveDate: yesterday });

    const { req, res } = mockReqRes({ user, body: { actionType: 'daily_read' } });
    await progressController.verifyDailyStreak(req, res);

    expect(res.body.currentStreak).toBe(6);
    expect(res.body.longestStreak).toBe(6);
  });

  test("getMyStreak auto-breaks the streak after a missed day, then a fresh action restarts it at 1 (not 8)", async () => {
    const threeDaysAgo = toDateString(daysAgo(3));
    const user = await makeUser({ currentStreak: 7, longestStreak: 7, lastActiveDate: threeDaysAgo });

    const { req, res } = mockReqRes({ user });
    await progressController.getMyStreak(req, res);

    expect(res.body.currentStreak).toBe(0); // auto-broken on read
    expect(res.body.longestStreak).toBe(7); // the record itself isn't erased

    const { req: req2, res: res2 } = mockReqRes({ user, body: { actionType: 'idea_submission' } });
    await progressController.verifyDailyStreak(req2, res2);
    expect(res2.body.currentStreak).toBe(1); // fresh start, not a continuation of the old streak
  });

  test('same-day repeated actions do not double-increment (the 1-of-3 dedupe rule)', async () => {
    const user = await makeUser();

    const first = mockReqRes({ user, body: { actionType: 'daily_read' } });
    await progressController.verifyDailyStreak(first.req, first.res);
    expect(first.res.body.currentStreak).toBe(1);

    // Same calendar day, a DIFFERENT action type — already qualifies today,
    // so this must record the action but NOT increment the streak again.
    const second = mockReqRes({ user, body: { actionType: 'module_progress' } });
    await progressController.verifyDailyStreak(second.req, second.res);
    expect(second.res.body.currentStreak).toBe(1);
    expect(second.res.body.todayActions).toEqual(['daily_read', 'module_progress']);
  });

  test("a bystander's identical-looking history is untouched by another user's multi-day simulation", async () => {
    const yesterday = toDateString(daysAgo(1));
    const activeUser = await makeUser({ currentStreak: 2, lastActiveDate: yesterday });
    // Deliberately same shape/values as activeUser's starting state, to make
    // sure isolation isn't accidentally "working" only because the values differ.
    const bystander = await makeUser({ currentStreak: 2, longestStreak: 2, lastActiveDate: yesterday });

    const { req, res } = mockReqRes({ user: activeUser, body: { actionType: 'daily_read' } });
    await progressController.verifyDailyStreak(req, res);
    expect(res.body.currentStreak).toBe(3);

    const freshBystander = await User.findById(bystander._id);
    expect(freshBystander.currentStreak).toBe(2);
    expect(freshBystander.lastActiveDate).toBe(yesterday);
    expect(freshBystander.engagementHistory).toHaveLength(0);
  });
});

// =========================================================================
// SCENARIO 3 — Database layer audit: prove the query is user-scoped, not a
// blanket update. This is the literal regression guard for the reported bug
// — if a future change ever swaps findById+save for something collection-wide
// (updateMany, a bare update() with an empty filter, bulkWrite without a
// per-doc filter), these assertions fail immediately.
// =========================================================================
describe('Scenario 3: Database layer audit (query validation)', () => {
  test('verifyDailyStreak reads/writes exactly one document, addressed by the acting user\'s own _id', async () => {
    const userA = await makeUser();

    const findByIdSpy = jest.spyOn(User, 'findById');
    const updateManySpy = jest.spyOn(User, 'updateMany');
    const bulkWriteSpy = jest.spyOn(User, 'bulkWrite');
    const updateOneSpy = jest.spyOn(User, 'updateOne');

    const { req, res } = mockReqRes({ user: userA, body: { actionType: 'daily_read' } });
    await progressController.verifyDailyStreak(req, res);

    // Exactly one targeted lookup, and it must resolve to userA's own id —
    // not undefined, not a filter object, not a different user's id.
    expect(findByIdSpy).toHaveBeenCalledTimes(1);
    const lookupArg = findByIdSpy.mock.calls[0][0];
    expect(lookupArg.toString()).toBe(userA._id.toString());

    // The dangerous "every document" shapes must never be invoked by this path.
    expect(updateManySpy).not.toHaveBeenCalled();
    expect(bulkWriteSpy).not.toHaveBeenCalled();
    expect(updateOneSpy).not.toHaveBeenCalled();

    findByIdSpy.mockRestore();
    updateManySpy.mockRestore();
    bulkWriteSpy.mockRestore();
    updateOneSpy.mockRestore();
  });

  test('getMyStreak\'s auto-break save only persists the one document it read, never a collection-wide op', async () => {
    const staleUser = await makeUser({ currentStreak: 4, lastActiveDate: toDateString(daysAgo(5)) });
    const bystander = await makeUser({ currentStreak: 4, lastActiveDate: toDateString(daysAgo(5)) });

    const updateManySpy = jest.spyOn(User, 'updateMany');
    const bulkWriteSpy = jest.spyOn(User, 'bulkWrite');

    const { req, res } = mockReqRes({ user: staleUser });
    await progressController.getMyStreak(req, res);

    expect(updateManySpy).not.toHaveBeenCalled();
    expect(bulkWriteSpy).not.toHaveBeenCalled();

    const freshStale = await User.findById(staleUser._id);
    const freshBystander = await User.findById(bystander._id);
    expect(freshStale.currentStreak).toBe(0); // this one legitimately broke
    expect(freshBystander.currentStreak).toBe(4); // identical starting state, but untouched

    updateManySpy.mockRestore();
    bulkWriteSpy.mockRestore();
  });

  test('the persisted document\'s _id after save matches the requesting user\'s _id exactly', async () => {
    const userA = await makeUser();
    const saveSpy = jest.spyOn(User.prototype, 'save');

    const { req, res } = mockReqRes({ user: userA, body: { actionType: 'daily_read' } });
    await progressController.verifyDailyStreak(req, res);

    expect(saveSpy).toHaveBeenCalledTimes(1);
    // `this` inside the spied save() call is the document instance being saved.
    const savedDoc = saveSpy.mock.instances[0];
    expect(savedDoc._id.toString()).toBe(userA._id.toString());

    saveSpy.mockRestore();
  });
});
