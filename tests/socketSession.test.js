// tests/socketSession.test.js
//
// Socket.IO handshake authentication: a socket is bound only to the user its
// JWT + session cookie prove, never to a user id the client claims.
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { connect, closeDatabase, clearCollections } = require('./setup/inMemoryMongo');
const { makeUser } = require('./setup/fixtures');
const { socketAuthMiddleware, bindSocket, unbindSocket, readCookie, attachSocketSessions } = require('../src/utils/socketSession');

jest.setTimeout(60000);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret-do-not-use-in-prod';

beforeAll(connect);
afterAll(closeDatabase);
afterEach(clearCollections);

function session(user) {
  const bindingSecret = crypto.randomBytes(32).toString('hex');
  const bh = crypto.createHash('sha256').update(bindingSecret).digest('hex');
  const token = jwt.sign({ user: { id: user._id.toString(), role: user.role, bh, sessionId: crypto.randomUUID() } }, process.env.JWT_SECRET, { expiresIn: '1h' });
  return { token, bindingSecret };
}
const fakeSocket = ({ token, cookie }, id = 'sock-1') => ({
  id,
  data: {},
  handshake: { auth: token ? { token } : {}, headers: cookie ? { cookie } : {} },
  handlers: {},
  on(evt, fn) { this.handlers[evt] = fn; },
});
const runMiddleware = (socket) => new Promise((resolve) => socketAuthMiddleware()(socket, (err) => resolve(err || null)));

test('a valid token + session cookie binds the socket to that user', async () => {
  const user = await makeUser();
  const { token, bindingSecret } = session(user);
  const socket = fakeSocket({ token, cookie: `theme=dark; orbit_bind=${bindingSecret}` });
  expect(await runMiddleware(socket)).toBeNull();
  expect(socket.data.userId).toBe(user._id.toString());
});

test.each([
  ['no token', (s) => ({ cookie: `orbit_bind=${s.bindingSecret}` })],
  ['no session cookie', (s) => ({ token: s.token })],
  ['a cookie from another browser', (s) => ({ token: s.token, cookie: 'orbit_bind=someone-else' })],
  ['a forged token', (s) => ({ token: jwt.sign({ user: { id: 'x', bh: 'y' } }, 'wrong-secret'), cookie: `orbit_bind=${s.bindingSecret}` })],
])('the handshake is refused with %s', async (_, build) => {
  const user = await makeUser();
  const socket = fakeSocket(build(session(user)));
  const err = await runMiddleware(socket);
  expect(err && err.message).toBe('unauthorized');
  expect(socket.data.userId).toBeUndefined();
});

test('register_session can no longer bind a socket to someone else', async () => {
  const user = await makeUser();
  const victim = await makeUser();
  const { token, bindingSecret } = session(user);
  const sockets = new Map();
  let middleware; let onConnection;
  attachSocketSessions({ use: (fn) => { middleware = fn; }, on: (evt, fn) => { onConnection = fn; } }, sockets);

  const socket = fakeSocket({ token, cookie: `orbit_bind=${bindingSecret}` });
  await new Promise((resolve) => middleware(socket, resolve));
  onConnection(socket);
  socket.handlers.register_session(victim._id.toString()); // claim another user
  expect([...sockets.keys()]).toEqual([user._id.toString()]);
  expect(sockets.has(victim._id.toString())).toBe(false);

  socket.handlers.disconnect();
  expect(sockets.size).toBe(0);
});

test('bind/unbind keep several tabs of one user separate', () => {
  const sockets = new Map();
  const a = { id: 'a', data: { userId: 'u1' } };
  const b = { id: 'b', data: { userId: 'u1' } };
  bindSocket(a, sockets); bindSocket(b, sockets); bindSocket(a, sockets);
  expect(sockets.get('u1')).toEqual(['a', 'b']);
  unbindSocket(a, sockets);
  expect(sockets.get('u1')).toEqual(['b']);
  expect(readCookie('x=1; orbit_bind=abc%20d; y=2', 'orbit_bind')).toBe('abc d');
  expect(readCookie('', 'orbit_bind')).toBeUndefined();
});
