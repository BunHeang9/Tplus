// DB-backed - see tests/README.md. Scratch accounts only.
//
// POST /api/users/:id/reset-password (userController.resetPassword) had no
// test coverage before this file - added alongside wiring
// notifyPasswordChanged() into it, rather than leaving a new behavior
// (the notification) as the only untested part of an already-untested
// endpoint.
//
// utils/mailer.js is mocked regardless of real SMTP_* config - see
// tests/controllers/authController.forgotPassword.test.js's own comment
// for why tests must never depend on or trigger a real send.
jest.mock('../../utils/mailer', () => ({ notifyPasswordChanged: jest.fn().mockResolvedValue({ sent: false, reason: 'test_mock' }) }));

const bcrypt = require('bcryptjs');
const sequelize = require('../../config/sequelize');
const userController = require('../../controllers/userController');
const userModel = require('../../models/userModel');
const { notifyPasswordChanged } = require('../../utils/mailer');

function fakeRes() {
  return { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}

async function makeAccount(overrides = {}) {
  const passwordHash = await bcrypt.hash('OriginalPass123', 10);
  return userModel.create({
    username: 'TEST-JEST-ADMINRESET-' + Date.now() + Math.floor(Math.random() * 1000),
    passwordHash, fullName: 'Test AdminReset', role: 'viewer', isActive: true,
    ...overrides,
  });
}

afterAll(async () => {
  await sequelize.query("DELETE FROM dbo.api_user WHERE username LIKE 'TEST-JEST-ADMINRESET-%'");
});

beforeEach(() => {
  notifyPasswordChanged.mockClear();
});

test('an admin resets the target account\'s password and it actually changes', async () => {
  const target = await makeAccount();
  const req = { params: { id: target.user_id }, body: { new_password: 'AdminSetPass456' }, user: { user_id: 999, username: 'TEST-JEST-ADMIN-ACTOR' } };
  const res = fakeRes();
  await userController.resetPassword(req, res, () => {});

  expect(res.body.message).toBe(`Password reset for ${target.username}`);

  const updated = await userModel.findByUsername(target.username);
  expect(await bcrypt.compare('AdminSetPass456', updated.password_hash)).toBe(true);

  await sequelize.query('DELETE FROM dbo.api_user WHERE user_id = :id', { replacements: { id: target.user_id } });
});

test('notifies the target\'s email, naming which admin did it', async () => {
  const email = 'jest-adminreset-notify-' + Date.now() + '@example.com';
  const target = await makeAccount({ email });
  const req = { params: { id: target.user_id }, body: { new_password: 'AdminSetPass456' }, user: { user_id: 999, username: 'TEST-JEST-ADMIN-ACTOR' } };
  const res = fakeRes();
  await userController.resetPassword(req, res, () => {});

  expect(notifyPasswordChanged).toHaveBeenCalledWith(email, 'by an administrator (TEST-JEST-ADMIN-ACTOR)');

  await sequelize.query('DELETE FROM dbo.api_user WHERE user_id = :id', { replacements: { id: target.user_id } });
});

test('a target account with no email still succeeds - no crash from a null recipient', async () => {
  const target = await makeAccount(); // no email
  const req = { params: { id: target.user_id }, body: { new_password: 'AdminSetPass456' }, user: { user_id: 999, username: 'TEST-JEST-ADMIN-ACTOR' } };
  const res = fakeRes();
  await userController.resetPassword(req, res, () => {});

  expect(res.body.message).toBe(`Password reset for ${target.username}`);
  expect(notifyPasswordChanged).toHaveBeenCalledWith(null, 'by an administrator (TEST-JEST-ADMIN-ACTOR)');

  await sequelize.query('DELETE FROM dbo.api_user WHERE user_id = :id', { replacements: { id: target.user_id } });
});

test('rejects a new_password under 8 characters', async () => {
  const target = await makeAccount();
  const req = { params: { id: target.user_id }, body: { new_password: 'short' }, user: { user_id: 999, username: 'TEST-JEST-ADMIN-ACTOR' } };
  const res = fakeRes();
  await userController.resetPassword(req, res, () => {});
  expect(res.statusCode).toBe(400);

  await sequelize.query('DELETE FROM dbo.api_user WHERE user_id = :id', { replacements: { id: target.user_id } });
});

test('a nonexistent target user_id gets 404', async () => {
  const req = { params: { id: 999999999 }, body: { new_password: 'AdminSetPass456' }, user: { user_id: 999, username: 'TEST-JEST-ADMIN-ACTOR' } };
  const res = fakeRes();
  await userController.resetPassword(req, res, () => {});
  expect(res.statusCode).toBe(404);
});
