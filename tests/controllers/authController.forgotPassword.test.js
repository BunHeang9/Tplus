// DB-backed - see tests/README.md. Scratch accounts only. No SMTP is
// configured in this environment, so sendMail() falls back to logging
// instead of actually emailing (see utils/mailer.js) - safe to call for
// real here, nothing external happens.
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const sequelize = require('../../config/sequelize');
const authController = require('../../controllers/authController');
const userModel = require('../../models/userModel');

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

describe('forgotPassword', () => {
  test('an account with an email gets the generic response and a real token gets set', async () => {
    const account = await makeAccount({ email: 'jest-fp-' + Date.now() + '@example.com' });
    const res = fakeRes();
    await authController.forgotPassword(fakeReq({ username: account.username }), res, () => {});

    expect(res.body.message).toMatch(/if an account exists/i);

    const [row] = await sequelize.query(
      'SELECT reset_token_hash, reset_token_expires_at FROM dbo.api_user WHERE user_id = :id',
      { replacements: { id: account.user_id }, type: QueryTypes.SELECT },
    );
    expect(row.reset_token_hash).not.toBeNull();
    expect(new Date(row.reset_token_expires_at).getTime()).toBeGreaterThan(Date.now());

    await sequelize.query('DELETE FROM dbo.api_user WHERE user_id = :id', { replacements: { id: account.user_id } });
  });

  test('an account with NO email gets the identical response and no token is set', async () => {
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

describe('resetPasswordWithToken', () => {
  test('a valid token resets the password', async () => {
    const account = await makeAccount({ email: 'jest-rp-' + Date.now() + '@example.com' });
    const rawToken = crypto.randomBytes(16).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    await userModel.setResetToken(account.user_id, tokenHash, 60);

    const res = fakeRes();
    await authController.resetPasswordWithToken(fakeReq({ token: rawToken, new_password: 'ControllerNewPass1' }), res, () => {});
    expect(res.body.message).toMatch(/password has been reset/i);

    const updated = await userModel.findByUsername(account.username);
    expect(await bcrypt.compare('ControllerNewPass1', updated.password_hash)).toBe(true);

    await sequelize.query('DELETE FROM dbo.api_user WHERE user_id = :id', { replacements: { id: account.user_id } });
  });

  test('an invalid token is rejected with 400', async () => {
    const res = fakeRes();
    await authController.resetPasswordWithToken(fakeReq({ token: 'bogus-token-xyz', new_password: 'ShouldNotApply1' }), res, () => {});
    expect(res.statusCode).toBe(400);
  });

  test('a too-short new_password is rejected', async () => {
    const res = fakeRes();
    await authController.resetPasswordWithToken(fakeReq({ token: 'whatever', new_password: 'short' }), res, () => {});
    expect(res.statusCode).toBe(400);
  });

  test('rejects a request missing either field', async () => {
    const res = fakeRes();
    await authController.resetPasswordWithToken(fakeReq({ token: 'whatever' }), res, () => {});
    expect(res.statusCode).toBe(400);
  });
});
