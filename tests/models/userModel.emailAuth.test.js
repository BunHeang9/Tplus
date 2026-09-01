// DB-backed - see tests/README.md. Scratch accounts only.
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const sequelize = require('../../config/sequelize');
const userModel = require('../../models/userModel');

async function makeAccount(overrides = {}) {
  const passwordHash = await bcrypt.hash('ScratchPass123', 10);
  return userModel.create({
    username: 'TEST-JEST-EMAILAUTH-' + Date.now() + Math.floor(Math.random() * 1000),
    passwordHash, fullName: 'Test EmailAuth', role: 'viewer', isActive: true,
    ...overrides,
  });
}

afterAll(async () => {
  await sequelize.query("DELETE FROM dbo.api_user WHERE username LIKE 'TEST-JEST-EMAILAUTH-%'");
});

describe('findByUsernameOrEmail', () => {
  test('finds an account by its real username', async () => {
    const account = await makeAccount({ email: 'jest-a-' + Date.now() + '@example.com' });
    const found = await userModel.findByUsernameOrEmail(account.username);
    expect(found.user_id).toBe(account.user_id);
    await sequelize.query('DELETE FROM dbo.api_user WHERE user_id = :id', { replacements: { id: account.user_id } });
  });

  test('finds an account by its email when no username matches', async () => {
    const email = 'jest-b-' + Date.now() + '@example.com';
    const account = await makeAccount({ email });
    const found = await userModel.findByUsernameOrEmail(email);
    expect(found.user_id).toBe(account.user_id);
    await sequelize.query('DELETE FROM dbo.api_user WHERE user_id = :id', { replacements: { id: account.user_id } });
  });

  test('username match takes priority over a same-string email match', async () => {
    const shared = 'TEST-JEST-EMAILAUTH-SHARED-' + Date.now();
    const byUsername = await makeAccount({ username: shared, email: 'jest-c-' + Date.now() + '@example.com' });
    const byEmail = await makeAccount({ email: shared }); // this account's EMAIL equals the other's USERNAME

    const found = await userModel.findByUsernameOrEmail(shared);
    expect(found.user_id).toBe(byUsername.user_id); // not byEmail

    await sequelize.query('DELETE FROM dbo.api_user WHERE user_id IN (:a, :b)', { replacements: { a: byUsername.user_id, b: byEmail.user_id } });
  });

  test('returns null for an identifier matching nothing', async () => {
    const found = await userModel.findByUsernameOrEmail('TEST-JEST-EMAILAUTH-NOBODY-' + Date.now());
    expect(found).toBeNull();
  });
});

describe('setResetToken / redeemResetToken', () => {
  test('a valid, unexpired token redeems successfully and changes the password', async () => {
    const account = await makeAccount();
    const rawToken = crypto.randomBytes(16).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    await userModel.setResetToken(account.user_id, tokenHash, 60);

    const newHash = await bcrypt.hash('BrandNewPass456', 10);
    const result = await userModel.redeemResetToken(tokenHash, newHash);
    expect(result).not.toBeNull();
    expect(result.user_id).toBe(account.user_id);

    const updated = await userModel.findByUsername(account.username);
    expect(await bcrypt.compare('BrandNewPass456', updated.password_hash)).toBe(true);

    await sequelize.query('DELETE FROM dbo.api_user WHERE user_id = :id', { replacements: { id: account.user_id } });
  });

  test('an expired token is rejected', async () => {
    const account = await makeAccount();
    const rawToken = crypto.randomBytes(16).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    // Set directly with an already-past expiry, bypassing setResetToken's
    // own DATEADD(+minutes) so this test can express "already expired"
    // without waiting.
    await sequelize.query(
      'UPDATE dbo.api_user SET reset_token_hash = :hash, reset_token_expires_at = DATEADD(MINUTE, -1, GETDATE()) WHERE user_id = :id',
      { replacements: { hash: tokenHash, id: account.user_id } },
    );

    const newHash = await bcrypt.hash('ShouldNotApply789', 10);
    const result = await userModel.redeemResetToken(tokenHash, newHash);
    expect(result).toBeNull();

    await sequelize.query('DELETE FROM dbo.api_user WHERE user_id = :id', { replacements: { id: account.user_id } });
  });

  test('a token is single-use - redeeming it twice only succeeds once', async () => {
    const account = await makeAccount();
    const rawToken = crypto.randomBytes(16).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    await userModel.setResetToken(account.user_id, tokenHash, 60);

    const hash1 = await bcrypt.hash('FirstUse111', 10);
    const first = await userModel.redeemResetToken(tokenHash, hash1);
    expect(first).not.toBeNull();

    const hash2 = await bcrypt.hash('SecondUse222', 10);
    const second = await userModel.redeemResetToken(tokenHash, hash2);
    expect(second).toBeNull();

    await sequelize.query('DELETE FROM dbo.api_user WHERE user_id = :id', { replacements: { id: account.user_id } });
  });

  test('a wrong token hash is rejected', async () => {
    const account = await makeAccount();
    const rawToken = crypto.randomBytes(16).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    await userModel.setResetToken(account.user_id, tokenHash, 60);

    const wrongHash = crypto.createHash('sha256').update('not-the-right-token').digest('hex');
    const newHash = await bcrypt.hash('ShouldNotApply333', 10);
    const result = await userModel.redeemResetToken(wrongHash, newHash);
    expect(result).toBeNull();

    await sequelize.query('DELETE FROM dbo.api_user WHERE user_id = :id', { replacements: { id: account.user_id } });
  });
});

describe('update() with email', () => {
  test('sets an email on an account that had none', async () => {
    const account = await makeAccount();
    expect(account.email).toBeNull();

    const updated = await userModel.update(account.user_id, { email: 'jest-set-' + Date.now() + '@example.com' });
    expect(updated.email).toMatch(/^jest-set-/);

    await sequelize.query('DELETE FROM dbo.api_user WHERE user_id = :id', { replacements: { id: account.user_id } });
  });
});
