// tests/forgotPassword.test.js
//
// Forgot-password: the reset email must actually be addressed to the user
// (sendEmail() reads `email`, not `to`), and the link must point at the
// frontend (CLIENT_URL) — never at whatever Host header the caller sent.
jest.mock('../src/utils/sendEmail', () => jest.fn(async () => ({ messageId: 'test' })));

const crypto = require('crypto');
const sendEmail = require('../src/utils/sendEmail');
const User = require('../src/models/User');
const { connect, closeDatabase, clearCollections } = require('./setup/inMemoryMongo');
const { makeUser } = require('./setup/fixtures');
const { forgotPassword, resetPassword } = require('../src/controllers/authController');

jest.setTimeout(60000);

beforeAll(connect);
afterAll(closeDatabase);
afterEach(async () => { await clearCollections(); sendEmail.mockClear(); });

function mockReqRes({ body = {}, params = {}, host = 'evil.example.com' } = {}) {
  const req = { body, params, protocol: 'https', get: (h) => (h.toLowerCase() === 'host' ? host : undefined) };
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return { req, res };
}

test('sends the reset email to the user with a link to the frontend, then the link resets the password', async () => {
  const prev = process.env.CLIENT_URL;
  process.env.CLIENT_URL = 'https://orbit.example.com/, http://localhost:5173';
  try {
    const user = await makeUser();
    const { req, res } = mockReqRes({ body: { email: user.email } });
    await forgotPassword(req, res);

    expect(res.statusCode).toBe(200);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const mail = sendEmail.mock.calls[0][0];
    expect(mail.email).toBe(user.email);
    expect(mail.html).not.toContain('evil.example.com');
    const link = mail.html.match(/https:\/\/orbit\.example\.com\/reset-password\/([a-f0-9]+)/);
    expect(link).not.toBeNull();

    const reset = mockReqRes({ body: { password: crypto.randomBytes(24).toString('base64url') }, params: { token: link[1] } });
    await resetPassword(reset.req, reset.res);
    expect(reset.res.statusCode).toBe(200);
    const after = await User.findById(user._id).select('+resetPasswordToken +resetPasswordExpire');
    expect(after.resetPasswordToken).toBeUndefined();
  } finally {
    process.env.CLIENT_URL = prev;
  }
});

test('an unknown email gets the same generic answer and no mail', async () => {
  const { req, res } = mockReqRes({ body: { email: 'nobody@irisregtech.com' } });
  await forgotPassword(req, res);
  expect(res.statusCode).toBe(200);
  expect(sendEmail).not.toHaveBeenCalled();
});
