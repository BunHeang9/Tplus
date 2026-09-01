// DB-backed - see tests/README.md. One scratch account, created and deleted
// by this file only.
//
// Calls the controller function directly (a fake req/res, no real HTTP
// server) - same approach used to verify the unhandled-rejection fix
// elsewhere in this migration. What matters here is the logic inside
// changePassword() itself, not Express's routing.
const bcrypt = require('bcryptjs');
const { QueryTypes } = require('sequelize');
const sequelize = require('../../config/sequelize');
const authController = require('../../controllers/authController');
const userModel = require('../../models/userModel');

function fakeRes() {
  return { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}

let scratchUser;

beforeAll(async () => {
  const passwordHash = await bcrypt.hash('OriginalPass123', 10);
  scratchUser = await userModel.create({
    username: 'TEST-JEST-CHANGEPW-' + Date.now(),
    passwordHash,
    fullName: 'Test ChangePassword',
    role: 'viewer',
    isActive: true,
  });
});

afterAll(async () => {
  await sequelize.query('DELETE FROM dbo.api_user WHERE user_id = :id', { replacements: { id: scratchUser.user_id } });
});

function callAsScratchUser(body) {
  const req = { user: { user_id: scratchUser.user_id, username: scratchUser.username, role: 'viewer' }, body };
  const res = fakeRes();
  let nextErr = 'NOT CALLED';
  return authController.changePassword(req, res, (err) => { nextErr = err; }).then(() => ({ res, nextErr }));
}

test('rejects a request missing either field', async () => {
  const { res } = await callAsScratchUser({ current_password: 'OriginalPass123' });
  expect(res.statusCode).toBe(400);
});

test('rejects a new_password under 8 characters', async () => {
  const { res } = await callAsScratchUser({ current_password: 'OriginalPass123', new_password: 'short' });
  expect(res.statusCode).toBe(400);
});

test('rejects the wrong current_password', async () => {
  const { res } = await callAsScratchUser({ current_password: 'WrongPassword', new_password: 'NewPassword456' });
  expect(res.statusCode).toBe(401);
});

test('accepts the correct current_password and actually changes it', async () => {
  const { res } = await callAsScratchUser({ current_password: 'OriginalPass123', new_password: 'NewPassword456' });
  expect(res.statusCode).toBeNull(); // res.json() without an explicit status defaults to 200 - no .status() call happened
  expect(res.body.message).toBe('Password changed');

  const updated = await userModel.findByUsername(scratchUser.username);
  const matchesNew = await bcrypt.compare('NewPassword456', updated.password_hash);
  const matchesOld = await bcrypt.compare('OriginalPass123', updated.password_hash);
  expect(matchesNew).toBe(true);
  expect(matchesOld).toBe(false);
});

test('a user_id in the body is ignored - only ever changes the caller\'s own account', async () => {
  const [otherAccount] = await sequelize.query(
    'SELECT TOP 1 user_id, password_hash FROM dbo.api_user WHERE user_id != :id',
    { replacements: { id: scratchUser.user_id }, type: QueryTypes.SELECT },
  );

  await callAsScratchUser({
    user_id: otherAccount.user_id, // an attempt to target someone else
    current_password: 'NewPassword456',
    new_password: 'FinalPassword789',
  });

  const [otherAfter] = await sequelize.query(
    'SELECT password_hash FROM dbo.api_user WHERE user_id = :id',
    { replacements: { id: otherAccount.user_id }, type: QueryTypes.SELECT },
  );
  expect(otherAfter.password_hash).toBe(otherAccount.password_hash); // untouched

  const scratchAfter = await userModel.findByUsername(scratchUser.username);
  const scratchGotTheChange = await bcrypt.compare('FinalPassword789', scratchAfter.password_hash);
  expect(scratchGotTheChange).toBe(true); // the caller's own account did change
});
