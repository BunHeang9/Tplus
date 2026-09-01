// DB-backed - see tests/README.md. Scratch accounts only.
//
// utils/mailer.js is mocked regardless of what SMTP_* is set to in this
// environment's .env - tests must never depend on (or trigger) a real
// email send. Without this, forgotPassword() below would actually hand a
// message to a real SMTP server addressed to a fake @example.com scratch
// account the moment SMTP is genuinely configured, which is exactly what
// happened live once real Gmail credentials were added - caught and fixed
// here rather than left for the next test run to repeat.
jest.mock('../../utils/mailer', () => ({
  sendMail: jest.fn().mockResolvedValue({ sent: false, reason: 'test_mock' }),
  notifyPasswordChanged: jest.fn().mockResolvedValue({ sent: false, reason: 'test_mock' }),
}));

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const sequelize = require('../../config/sequelize');
const authController = require('../../controllers/authController');
const userModel = require('../../models/userModel');
const { sendMail, notifyPasswordChanged } = require('../../utils/mailer');

function fakeRes() {
  return { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
function fakeReq(body) { return { body, ip: '127.0.0.1' }; }

async function makeAccount(overrides = {}) {
  const passwordHash = await bcrypt.hash('ScratchPass123', 10);
  return userModel.create({
    username: 'TEST-JEST-FORGOTPW-' + Date.now() + Math.floor(Math.random() * 1000),
    passwordHash, fullName: 'Test ForgotPw', role: 'viewer', isActive: true,
    ...overrides,
  });
}

afterAll(async () => {
  await sequelize.query("DELETE FROM dbo.api_user WHERE username LIKE 'TEST-JEST-FORGOTPW-%'");
});

beforeEach(() => {
  sendMail.mockClear();
});

describe('forgotPassword', () => {
  test('an account with an email gets the generic response, a real code gets set, and the mocked mailer is called with it', async () => {
    const email = 'jest-fp-' + Date.now() + '@example.com';
    const account = await makeAccount({ email });
    const res = fakeRes();
    await authController.forgotPassword(fakeReq({ username: account.username }), res, () => {});

    expect(res.body.message).toMatch(/if an account exists/i);

    expect(sendMail).toHaveBeenCalledTimes(1);
    const call = sendMail.mock.calls[0][0];
    expect(call.to).toBe(email);
    expect(call.subject).toMatch(/reset code/i);
    const codeInEmail = call.text.match(/\b(\d{6})\b/)[1];

    const [row] = await sequelize.query(
      'SELECT reset_token_hash, reset_token_expires_at, reset_token_attempts FROM dbo.api_user WHERE user_id = :id',
      { replacements: { id: account.user_id }, type: QueryTypes.SELECT },
    );
    expect(row.reset_token_hash).not.toBeNull();
    expect(row.reset_token_hash).toHaveLength(64); // SHA-256 hex, not the raw 6-digit code
    expect(row.reset_token_attempts).toBe(0);
    expect(new Date(row.reset_token_expires_at).getTime()).toBeGreaterThan(Date.now());
    // The code actually emailed hashes to what's stored - not just "some
    // hash got set", but specifically the one matching what the user
    // would type in.
    expect(crypto.createHash('sha256').update(codeInEmail).digest('hex')).toBe(row.reset_token_hash);

    await sequelize.query('DELETE FROM dbo.api_user WHERE user_id = :id', { replacements: { id: account.user_id } });
  });

  test('an account with NO email gets the identical response and no code is set', async () => {
    const account = await makeAccount(); // no email
    const res = fakeRes();
    await authController.forgotPassword(fakeReq({ username: account.username }), res, () => {});

    expect(res.body.message).toMatch(/if an account exists/i);

    const [row] = await sequelize.query(
      'SELECT reset_token_hash FROM dbo.api_user WHERE user_id = :id',
      { replacements: { id: account.user_id }, type: QueryTypes.SELECT },
    );
    expect(row.reset_token_hash).toBeNull();

    await sequelize.query('DELETE FROM dbo.api_user WHERE user_id = :id', { replacements: { id: account.user_id } });
  });

  test('a nonexistent username gets the identical response too', async () => {
    const res = fakeRes();
    await authController.forgotPassword(fakeReq({ username: 'TEST-JEST-FORGOTPW-NOBODY-' + Date.now() }), res, () => {});
    expect(res.body.message).toMatch(/if an account exists/i);
  });

  test('finds the account by email, not just username', async () => {
    const email = 'jest-fp-byemail-' + Date.now() + '@example.com';
    const account = await makeAccount({ email });
    const res = fakeRes();
    await authController.forgotPassword(fakeReq({ username: email }), res, () => {}); // note: sent in the "username" field

    const [row] = await sequelize.query(
      'SELECT reset_token_hash FROM dbo.api_user WHERE user_id = :id',
      { replacements: { id: account.user_id }, type: QueryTypes.SELECT },
    );
    expect(row.reset_token_hash).not.toBeNull();

    await sequelize.query('DELETE FROM dbo.api_user WHERE user_id = :id', { replacements: { id: account.user_id } });
  });

  test('rejects a request with no username at all', async () => {
    const res = fakeRes();
    await authController.forgotPassword(fakeReq({}), res, () => {});
    expect(res.statusCode).toBe(400);
  });
});

describe('resetPasswordWithCode', () => {
  test('a valid code resets the password and notifies the account email', async () => {
    const email = 'jest-rp-' + Date.now() + '@example.com';
    const account = await makeAccount({ email });
    const rawCode = '123456';
    const codeHash = crypto.createHash('sha256').update(rawCode).digest('hex');
    await userModel.setResetToken(account.user_id, codeHash, 10);

    const res = fakeRes();
    await authController.resetPasswordWithCode(
      fakeReq({ username: account.username, code: rawCode, new_password: 'ControllerNewPass1' }), res, () => {},
    );
    expect(res.body.message).toMatch(/password has been reset/i);
    expect(notifyPasswordChanged).toHaveBeenCalledWith(email, 'using a password-reset code');

    const updated = await userModel.findByUsername(account.username);
    expect(await bcrypt.compare('ControllerNewPass1', updated.password_hash)).toBe(true);

    await sequelize.query('DELETE FROM dbo.api_user WHERE user_id = :id', { replacements: { id: account.user_id } });
  });

  test('a wrong code is rejected with 400 and counts as an attempt', async () => {
    const account = await makeAccount({ email: 'jest-rp-' + Date.now() + '@example.com' });
    const codeHash = crypto.createHash('sha256').update('123456').digest('hex');
    await userModel.setResetToken(account.user_id, codeHash, 10);

    const res = fakeRes();
    await authController.resetPasswordWithCode(
      fakeReq({ username: account.username, code: '999999', new_password: 'ShouldNotApply1' }), res, () => {},
    );
    expect(res.statusCode).toBe(400);

    const [row] = await sequelize.query(
      'SELECT reset_token_attempts FROM dbo.api_user WHERE user_id = :id',
      { replacements: { id: account.user_id }, type: QueryTypes.SELECT },
    );
    expect(row.reset_token_attempts).toBe(1);

    await sequelize.query('DELETE FROM dbo.api_user WHERE user_id = :id', { replacements: { id: account.user_id } });
  });

  test('the 6th wrong guess locks the code out even if the 6th guess is actually correct', async () => {
    const account = await makeAccount({ email: 'jest-rp-' + Date.now() + '@example.com' });
    const rawCode = '654321';
    const codeHash = crypto.createHash('sha256').update(rawCode).digest('hex');
    await userModel.setResetToken(account.user_id, codeHash, 10);

    for (let i = 0; i < userModel.MAX_RESET_ATTEMPTS; i += 1) {
      const res = fakeRes();
      // eslint-disable-next-line no-await-in-loop
      await authController.resetPasswordWithCode(
        fakeReq({ username: account.username, code: 'wrong-' + i, new_password: 'ShouldNotApply1' }), res, () => {},
      );
      expect(res.statusCode).toBe(400);
    }

    // Attempts are now exhausted - even the real code no longer works.
    const res = fakeRes();
    await authController.resetPasswordWithCode(
      fakeReq({ username: account.username, code: rawCode, new_password: 'ShouldNotApplyEither1' }), res, () => {},
    );
    expect(res.statusCode).toBe(400);

    const updated = await userModel.findByUsername(account.username);
    expect(await bcrypt.compare('ShouldNotApplyEither1', updated.password_hash)).toBe(false);

    await sequelize.query('DELETE FROM dbo.api_user WHERE user_id = :id', { replacements: { id: account.user_id } });
  });

  test('an unknown username is rejected with 400', async () => {
    const res = fakeRes();
    await authController.resetPasswordWithCode(
      fakeReq({ username: 'TEST-JEST-FORGOTPW-NOBODY-' + Date.now(), code: '123456', new_password: 'ShouldNotApply1' }), res, () => {},
    );
    expect(res.statusCode).toBe(400);
  });

  test('a too-short new_password is rejected', async () => {
    const res = fakeRes();
    await authController.resetPasswordWithCode(fakeReq({ username: 'whoever', code: '123456', new_password: 'short' }), res, () => {});
    expect(res.statusCode).toBe(400);
  });

  test('rejects a request missing any field', async () => {
    const res = fakeRes();
    await authController.resetPasswordWithCode(fakeReq({ username: 'whoever', code: '123456' }), res, () => {});
    expect(res.statusCode).toBe(400);
  });
});
