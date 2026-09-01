// DB-backed - see tests/README.md. Scratch accounts only.
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
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

describe('setResetToken / redeemResetCode', () => {
  test('a valid, unexpired code redeems successfully and changes the password', async () => {
    const account = await makeAccount();
    const rawCode = '111111';
    const codeHash = crypto.createHash('sha256').update(rawCode).digest('hex');
    await userModel.setResetToken(account.user_id, codeHash, 10);

    const newHash = await bcrypt.hash('BrandNewPass456', 10);
    const result = await userModel.redeemResetCode(account.username, codeHash, newHash);
    expect(result).not.toBeNull();
    expect(result.user_id).toBe(account.user_id);

    const updated = await userModel.findByUsername(account.username);
    expect(await bcrypt.compare('BrandNewPass456', updated.password_hash)).toBe(true);

    await sequelize.query('DELETE FROM dbo.api_user WHERE user_id = :id', { replacements: { id: account.user_id } });
  });

  test('finds the account by email too, same as findByUsernameOrEmail', async () => {
    const email = 'jest-rc-' + Date.now() + '@example.com';
    const account = await makeAccount({ email });
    const rawCode = '222222';
    const codeHash = crypto.createHash('sha256').update(rawCode).digest('hex');
    await userModel.setResetToken(account.user_id, codeHash, 10);

    const newHash = await bcrypt.hash('BrandNewPass789', 10);
    const result = await userModel.redeemResetCode(email, codeHash, newHash);
    expect(result).not.toBeNull();
    expect(result.user_id).toBe(account.user_id);

    await sequelize.query('DELETE FROM dbo.api_user WHERE user_id = :id', { replacements: { id: account.user_id } });
  });

  test('an expired code is rejected', async () => {
    const account = await makeAccount();
    const rawCode = '333333';
    const codeHash = crypto.createHash('sha256').update(rawCode).digest('hex');
    // Set directly with an already-past expiry, bypassing setResetToken's
    // own DATEADD(+minutes) so this test can express "already expired"
    // without waiting.
    await sequelize.query(
      'UPDATE dbo.api_user SET reset_token_hash = :hash, reset_token_expires_at = DATEADD(MINUTE, -1, GETDATE()), reset_token_attempts = 0 WHERE user_id = :id',
      { replacements: { hash: codeHash, id: account.user_id } },
    );

    const newHash = await bcrypt.hash('ShouldNotApply789', 10);
    const result = await userModel.redeemResetCode(account.username, codeHash, newHash);
    expect(result).toBeNull();

    await sequelize.query('DELETE FROM dbo.api_user WHERE user_id = :id', { replacements: { id: account.user_id } });
  });

  test('a code is single-use - redeeming it twice only succeeds once', async () => {
    const account = await makeAccount();
    const rawCode = '444444';
    const codeHash = crypto.createHash('sha256').update(rawCode).digest('hex');
    await userModel.setResetToken(account.user_id, codeHash, 10);

    const hash1 = await bcrypt.hash('FirstUse111', 10);
    const first = await userModel.redeemResetCode(account.username, codeHash, hash1);
    expect(first).not.toBeNull();

    const hash2 = await bcrypt.hash('SecondUse222', 10);
    const second = await userModel.redeemResetCode(account.username, codeHash, hash2);
    expect(second).toBeNull();

    await sequelize.query('DELETE FROM dbo.api_user WHERE user_id = :id', { replacements: { id: account.user_id } });
  });

  test('a wrong code hash is rejected and increments the attempt counter', async () => {
    const account = await makeAccount();
    const rawCode = '555555';
    const codeHash = crypto.createHash('sha256').update(rawCode).digest('hex');
    await userModel.setResetToken(account.user_id, codeHash, 10);

    const wrongHash = crypto.createHash('sha256').update('000000').digest('hex');
    const newHash = await bcrypt.hash('ShouldNotApply333', 10);
    const result = await userModel.redeemResetCode(account.username, wrongHash, newHash);
    expect(result).toBeNull();

    const [row] = await sequelize.query(
      'SELECT reset_token_attempts FROM dbo.api_user WHERE user_id = :id',
      { replacements: { id: account.user_id }, type: QueryTypes.SELECT },
    );
    expect(row.reset_token_attempts).toBe(1);

    await sequelize.query('DELETE FROM dbo.api_user WHERE user_id = :id', { replacements: { id: account.user_id } });
  });

  test('locks out after MAX_RESET_ATTEMPTS wrong guesses, even for the real code', async () => {
    const account = await makeAccount();
    const rawCode = '666666';
    const codeHash = crypto.createHash('sha256').update(rawCode).digest('hex');
    const wrongHash = crypto.createHash('sha256').update('000000').digest('hex');
    await userModel.setResetToken(account.user_id, codeHash, 10);

    for (let i = 0; i < userModel.MAX_RESET_ATTEMPTS; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const attempt = await userModel.redeemResetCode(account.username, wrongHash, 'irrelevant-hash');
      expect(attempt).toBeNull();
    }

    const newHash = await bcrypt.hash('ShouldStillNotApply', 10);
    const finalTry = await userModel.redeemResetCode(account.username, codeHash, newHash);
    expect(finalTry).toBeNull();

    await sequelize.query('DELETE FROM dbo.api_user WHERE user_id = :id', { replacements: { id: account.user_id } });
  });

  test('setResetToken resets the attempt counter for a freshly issued code', async () => {
    const account = await makeAccount();
    const oldCodeHash = crypto.createHash('sha256').update('777777').digest('hex');
    await userModel.setResetToken(account.user_id, oldCodeHash, 10);
    const wrongHash = crypto.createHash('sha256').update('000000').digest('hex');
    await userModel.redeemResetCode(account.username, wrongHash, 'irrelevant-hash');
    await userModel.redeemResetCode(account.username, wrongHash, 'irrelevant-hash');

    const newCodeHash = crypto.createHash('sha256').update('888888').digest('hex');
    await userModel.setResetToken(account.user_id, newCodeHash, 10);

    const [row] = await sequelize.query(
      'SELECT reset_token_attempts FROM dbo.api_user WHERE user_id = :id',
      { replacements: { id: account.user_id }, type: QueryTypes.SELECT },
    );
    expect(row.reset_token_attempts).toBe(0);

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
