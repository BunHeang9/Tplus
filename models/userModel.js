const { DataTypes, Op, fn, literal } = require('sequelize');
const sequelize = require('../config/sequelize');

// Login accounts for the API itself (dbo.api_user) - separate from dbo.employee.

const ApiUser = sequelize.define('ApiUser', {
  user_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  username: { type: DataTypes.STRING(50), allowNull: false },
  password_hash: { type: DataTypes.STRING(255), allowNull: false },
  full_name: { type: DataTypes.STRING(150), allowNull: true },
  role: { type: DataTypes.STRING(20), allowNull: false },
  is_active: { type: DataTypes.BOOLEAN, allowNull: false },
  // Has its own DB-side default (legacy DATETIME, same treatment as
  // categoryModel/auditLogModel: let the DB default handle it rather than
  // have Sequelize generate an incompatible timestamp format).
  created_at: { type: DataTypes.DATE, allowNull: true },
  email: { type: DataTypes.STRING(255), allowNull: true },
  // Never returned by any read below (not in SAFE_FIELDS) - same treatment
  // as password_hash. Only ever a SHA-256 hash of the real token, which
  // itself only ever exists in the reset-link email - see authController.js
  // forgotPassword()/resetPasswordWithToken() for why.
  reset_token_hash: { type: DataTypes.STRING(64), allowNull: true },
  reset_token_expires_at: { type: DataTypes.DATE, allowNull: true },
  // Counts wrong-code guesses since the last code was issued. A 6-digit
  // code only has 1,000,000 possibilities (unlike the 32-byte link token
  // this replaced), so unlike that token this needs an explicit brute-force
  // cap - see redeemResetCode() below.
  reset_token_attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
}, {
  tableName: 'api_user',
  schema: 'dbo',
  timestamps: false,
});

const SAFE_FIELDS = ['user_id', 'username', 'full_name', 'email', 'role', 'is_active', 'created_at'];

const AUTH_ATTRIBUTES = ['user_id', 'username', 'password_hash', 'full_name', 'email', 'role', 'is_active'];

async function findByUsername(username) {
  return ApiUser.findOne({ where: { username }, attributes: AUTH_ATTRIBUTES, raw: true });
}

// The frontend's Sign In form now sends an email address in the same
// `username` field it always used - this resolves that value against
// EITHER column. Username is checked first and only falls back to email if
// nothing matched: a raw `WHERE username = ? OR email = ?` would leave which
// row wins undefined in the (currently hypothetical, but not impossible)
// case where one account's real email happens to equal a different
// account's literal username string - checking username first eliminates
// that ambiguity outright rather than leaving it to whatever order SQL
// Server happens to return matching rows in.
async function findByUsernameOrEmail(identifier) {
  const byUsername = await findByUsername(identifier);
  if (byUsername) return byUsername;
  return ApiUser.findOne({ where: { email: identifier }, attributes: AUTH_ATTRIBUTES, raw: true });
}

async function create({ username, passwordHash, fullName, email, role, isActive }) {
  const row = await ApiUser.create({
    username,
    password_hash: passwordHash,
    full_name: fullName || null,
    email: email || null,
    role: role || 'viewer',
    is_active: isActive === undefined ? true : isActive,
  });
  // password_hash deliberately excluded from what's returned, same as the
  // original INSERT's OUTPUT column list.
  const plain = row.get({ plain: true });
  const safe = {};
  for (const f of SAFE_FIELDS) safe[f] = plain[f];
  return safe;
}

async function findAll(includeInactive = true) {
  return ApiUser.findAll({
    attributes: SAFE_FIELDS,
    where: includeInactive ? {} : { is_active: true },
    order: [['is_active', 'DESC'], ['created_at', 'DESC']],
    raw: true,
  });
}

async function findById(id) {
  return ApiUser.findByPk(id, { attributes: SAFE_FIELDS, raw: true });
}

// Note: password_hash is deliberately never returned by findAll or findById.
async function update(id, { full_name, email, role, is_active }) {
  const values = {};
  if (full_name !== undefined && full_name !== null) values.full_name = full_name;
  if (email !== undefined && email !== null) values.email = email;
  if (role !== undefined && role !== null) values.role = role;
  if (is_active !== undefined && is_active !== null) values.is_active = is_active;

  if (Object.keys(values).length > 0) {
    await ApiUser.update(values, { where: { user_id: id } });
  }
  return findById(id);
}

async function setPassword(id, passwordHash) {
  const [count] = await ApiUser.update(
    { password_hash: passwordHash },
    { where: { user_id: id } },
  );
  if (count === 0) return null;
  return ApiUser.findByPk(id, { attributes: ['user_id', 'username'], raw: true });
}

// What still points at this account before it can be deleted. Only
// part_borrow_record's issued_by_id/received_by_id are checked - audit_log
// also stores actor_user_id, but it has no real foreign key to api_user at
// all (confirmed against sys.foreign_keys) and already snapshots
// actor_username/actor_name alongside it, so a deleted account's history
// there stays fully readable on its own, the same way borrow_record.
// borrower_name survives a deleted employee. part_borrow_record has no
// equivalent name-snapshot column for issued_by/received_by, though - so
// unlike employeeModel.remove() (which nulls the FK and keeps the name),
// there is no way to null this FK without permanently losing who issued or
// received that loan. Blocking the delete is the only option that doesn't
// destroy history.
//
// Lazily required - partBorrowModel.js does not require this file at all,
// but the lazy pattern is used here for consistency with the rest of this
// migration's cross-model reference checks.
async function countReferences(id) {
  const { PartBorrowRecord } = require('./partBorrowModel');
  const [issued, received] = await Promise.all([
    PartBorrowRecord.count({ where: { issued_by_id: id } }),
    PartBorrowRecord.count({ where: { received_by_id: id } }),
  ]);
  return { issued_part_loans: issued, received_part_loans: received };
}

// Permanent - no recycle_bin snapshot, unlike employee/equipment/department/
// software_license. An account is credentials, not a business record with
// history worth restoring; controllers/userController.js's own guards
// (last-admin, self-delete, still-referenced) are what actually keep this
// safe, not a recovery path.
async function remove(id) {
  const row = await ApiUser.findByPk(id, { attributes: SAFE_FIELDS, raw: true });
  if (!row) return null;
  await ApiUser.destroy({ where: { user_id: id } });
  return row;
}

async function countAdmins(excludeUserId) {
  return ApiUser.count({
    where: {
      role: 'admin',
      is_active: true,
      user_id: { [Op.ne]: excludeUserId || 0 },
    },
  });
}

// forgot-password: sets a new outstanding token, overwriting whatever
// (if anything) was there before - only ever one live reset token per
// account, so requesting a new link invalidates an older unused one.
//
// The expiry is computed in SQL (DATEADD off the DB server's own GETDATE()),
// not passed in as a JS Date - two reasons. First, a plain JS Date sent to
// this legacy DATETIME column gets serialized in a format SQL Server's
// legacy datetime type rejects outright ("Conversion failed when converting
// date and/or time from character string" - confirmed live), the same
// class of issue this migration has hit before with legacy DATETIME columns
// elsewhere in this app. Second, and independent of that bug, the DB
// server's clock is the right source of truth here anyway - the *validity*
// check in redeemResetToken() below already compares against GETDATE(), so
// the expiry itself should come from the same clock, not the app server's.
async function setResetToken(id, tokenHash, ttlMinutes) {
  await ApiUser.update(
    {
      reset_token_hash: tokenHash,
      reset_token_expires_at: fn('DATEADD', literal('MINUTE'), ttlMinutes, fn('GETDATE')),
      // A fresh code always gets a fresh attempt count - otherwise a user
      // who mistyped an old code a few times would start their new code
      // already partway toward the lockout below.
      reset_token_attempts: 0,
    },
    { where: { user_id: id } },
  );
}

// reset-password: verifies a 6-digit code rather than the 32-byte link
// token this replaced. A code that short (1,000,000 possibilities) is
// guessable within its expiry window if attempts aren't capped, so unlike
// redeemResetToken() before it, this can't be a single unconditional
// lookup-by-hash - it needs to know *which* account's attempt count to
// check and increment, hence the identifier argument.
//
// Two-phase, both against the DB server's own clock (GETDATE(), not a JS
// Date - same reasoning as setResetToken() above):
//   1. Try the atomic success path: matches the stored hash, not expired,
//      and under the attempt cap, all in one UPDATE's WHERE clause, so
//      (same as the token flow before it) a code is single-use by
//      construction - a second concurrent redeem finds no row left
//      matching once the first one clears the hash.
//   2. If that touched zero rows, the guess was wrong (or the code was
//      already expired/locked/absent) - bump the attempt counter for that
//      account's still-active code, if it has one, so repeated wrong
//      guesses eventually exceed maxAttempts and the code stops being
//      checkable at all, without needing a separate lockout flag.
const MAX_RESET_ATTEMPTS = 5;

async function redeemResetCode(identifier, codeHash, newPasswordHash, maxAttempts = MAX_RESET_ATTEMPTS) {
  const user = await findByUsernameOrEmail(identifier);
  if (!user) return null;

  const [count] = await ApiUser.update(
    {
      password_hash: newPasswordHash,
      reset_token_hash: null,
      reset_token_expires_at: null,
      reset_token_attempts: 0,
    },
    {
      where: {
        user_id: user.user_id,
        reset_token_hash: codeHash,
        reset_token_expires_at: { [Op.gt]: fn('GETDATE') },
        reset_token_attempts: { [Op.lt]: maxAttempts },
      },
    },
  );
  if (count > 0) return { user_id: user.user_id, username: user.username, email: user.email };

  // Wrong code (or nothing left to guess against) - only bump the counter
  // if there's still a live, unexpired code to protect; a wrong guess
  // against an already-expired or already-used code is a no-op either way.
  await ApiUser.update(
    { reset_token_attempts: literal('reset_token_attempts + 1') },
    {
      where: {
        user_id: user.user_id,
        reset_token_hash: { [Op.ne]: null },
        reset_token_expires_at: { [Op.gt]: fn('GETDATE') },
      },
    },
  );
  return null;
}

module.exports = {
  ApiUser,
  findByUsername, findByUsernameOrEmail, create, findAll, findById, update, setPassword, countAdmins,
  countReferences, remove, setResetToken, redeemResetCode, MAX_RESET_ATTEMPTS,
};
