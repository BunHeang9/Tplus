const { DataTypes } = require('sequelize');
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
}, {
  tableName: 'api_user',
  schema: 'dbo',
  timestamps: false,
});

const SAFE_FIELDS = ['user_id', 'username', 'full_name', 'role', 'is_active', 'created_at'];

async function findByUsername(username) {
  return ApiUser.findOne({
    where: { username },
    attributes: ['user_id', 'username', 'password_hash', 'full_name', 'role', 'is_active'],
    raw: true,
  });
}

async function create({ username, passwordHash, fullName, role, isActive }) {
  const row = await ApiUser.create({
    username,
    password_hash: passwordHash,
    full_name: fullName || null,
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
async function update(id, { full_name, role, is_active }) {
  const values = {};
  if (full_name !== undefined && full_name !== null) values.full_name = full_name;
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
  const { Op } = require('sequelize');
  return ApiUser.count({
    where: {
      role: 'admin',
      is_active: true,
      user_id: { [Op.ne]: excludeUserId || 0 },
    },
  });
}

module.exports = {
  ApiUser,
  findByUsername, create, findAll, findById, update, setPassword, countAdmins,
  countReferences, remove,
};
