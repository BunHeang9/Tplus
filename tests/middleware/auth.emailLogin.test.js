// DB-backed - see tests/README.md. One scratch account.
//
// This is the fix the frontend's own bug report didn't think to mention:
// the Sign In form change (email instead of username) only works end to
// end if authenticate() - which re-verifies credentials on EVERY request,
// not just login (see middleware/auth.js's own comment on why) - resolves
// an email the same way authController.login() does. Without this, a login
// call could succeed while every subsequent request from the same frontend
// failed with 401, since the request would still be sending email as the
// credential.
const bcrypt = require('bcryptjs');
const sequelize = require('../../config/sequelize');
const { authenticate } = require('../../middleware/auth');
const userModel = require('../../models/userModel');

let account;
const email = 'jest-authmw-' + Date.now() + '@example.com';

beforeAll(async () => {
  const passwordHash = await bcrypt.hash('MiddlewarePass123', 10);
  account = await userModel.create({
    username: 'TEST-JEST-AUTHMW-' + Date.now(),
    passwordHash, fullName: 'Test AuthMW', email, role: 'viewer', isActive: true,
  });
});

afterAll(async () => {
  await sequelize.query('DELETE FROM dbo.api_user WHERE user_id = :id', { replacements: { id: account.user_id } });
});

function fakeRes() {
  return { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}

function callAuthenticate(query) {
  return new Promise((resolve) => {
    const req = { headers: {}, query, body: {} };
    const res = fakeRes();
    let nextCalled = false;
    authenticate(req, res, () => { nextCalled = true; }).then(() => resolve({ req, res, nextCalled }));
  });
}

test('resolves req.user via a real username', async () => {
  const { req, nextCalled } = await callAuthenticate({ username: account.username, password: 'MiddlewarePass123' });
  expect(nextCalled).toBe(true);
  expect(req.user.user_id).toBe(account.user_id);
});

test('resolves req.user via email - the actual reported fix', async () => {
  const { req, nextCalled } = await callAuthenticate({ username: email, password: 'MiddlewarePass123' });
  expect(nextCalled).toBe(true);
  expect(req.user.user_id).toBe(account.user_id);
  expect(req.user.email).toBe(email);
});

test('still rejects a wrong password for the email identifier', async () => {
  const { res, nextCalled } = await callAuthenticate({ username: email, password: 'WrongPassword' });
  expect(nextCalled).toBe(false);
  expect(res.statusCode).toBe(401);
});

test('rejects an identifier matching nothing at all', async () => {
  const { res, nextCalled } = await callAuthenticate({ username: 'nobody-' + Date.now() + '@example.com', password: 'whatever123' });
  expect(nextCalled).toBe(false);
  expect(res.statusCode).toBe(401);
});
