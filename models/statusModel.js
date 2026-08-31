const { DataTypes, fn, col } = require('sequelize');
const sequelize = require('../config/sequelize');

// Equipment statuses (dbo.equipment_status).
//
// These are not just labels - is_assignable and is_borrowable drive what the
// stock and borrow features allow. Changing those flags changes behaviour, so
// they are worth understanding before editing a status.

const EquipmentStatus = sequelize.define('EquipmentStatus', {
  status_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  status_name: { type: DataTypes.STRING(50), allowNull: false },
  description: { type: DataTypes.STRING(255), allowNull: true },
  has_owner: { type: DataTypes.BOOLEAN, allowNull: true },
  is_assignable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  is_borrowable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  sort_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 99 },
  is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  // Has its own DB-side default (legacy DATETIME) - let the DB fill it in,
  // same reasoning as every other table with this pattern in this migration.
  created_at: { type: DataTypes.DATE, allowNull: true },
}, {
  tableName: 'equipment_status',
  schema: 'dbo',
  timestamps: false,
});

// equipment_count needs Equipment, and equipmentModel.js already imports
// EquipmentStatus from this file at ITS top level (for its own belongsTo) -
// so this file importing Equipment back at ITS OWN top level would be a
// real require cycle. Lazy instead (inside the function body, evaluated
// only when the function actually runs): by the time any request handler
// calls findAll()/findById(), the whole app has already finished starting
// up and every model file is already loaded, so this just returns the
// cached module. Same technique as departmentModel.js/categoryModel.js's
// own findAll()/countUsage().
async function findAll(includeInactive = false) {
  const { Equipment } = require('./equipmentModel');

  const counts = await Equipment.findAll({
    attributes: ['status_id', [fn('COUNT', col('equipment_id')), 'n']],
    group: ['status_id'],
    raw: true,
  });
  const countByStatus = new Map(counts.map((r) => [r.status_id, r.n]));

  const statuses = await EquipmentStatus.findAll({
    where: includeInactive ? {} : { is_active: true },
    order: [['sort_order', 'ASC'], ['status_id', 'ASC']],
    raw: true,
  });
  return statuses.map((s) => ({
    status_id: s.status_id,
    status_name: s.status_name,
    description: s.description,
    has_owner: s.has_owner,
    is_assignable: s.is_assignable,
    is_borrowable: s.is_borrowable,
    sort_order: s.sort_order,
    is_active: s.is_active,
    equipment_count: countByStatus.get(s.status_id) || 0,
  }));
}

async function findById(id) {
  const { Equipment } = require('./equipmentModel');

  const row = await EquipmentStatus.findByPk(id, { raw: true });
  if (!row) return null;
  const equipment_count = await Equipment.count({ where: { status_id: id } });
  // `s.*` in the original query, then equipment_count appended - a plain
  // read's key order matches physical column order here (confirmed live,
  // same as equipmentModel.js's own findByOwner()/findAll() - it's only a
  // .create()/.update() result that doesn't, per equipmentModel.js's
  // toPhysicalOrder() comment).
  return { ...row, equipment_count };
}

async function findByName(name) {
  return EquipmentStatus.findOne({ where: { status_name: name }, raw: true });
}

async function create(d) {
  const row = await EquipmentStatus.create({
    status_name: d.status_name,
    description: d.description || null,
    has_owner: !!d.has_owner,
    is_assignable: !!d.is_assignable,
    is_borrowable: !!d.is_borrowable,
    sort_order: d.sort_order ?? 99,
  });
  return row.get({ plain: true });
}

// Renaming a status has to update dbo.equipment too - that table keeps a text
// copy of the name alongside status_id, and leaving it stale would make the
// two disagree. Both happen in one transaction.
//
// The boolean fields (has_owner/is_assignable/is_borrowable/is_active) and
// the plain fields (status_name/description/sort_order) skip differently
// here, matching the original COALESCE-vs-ternary split exactly: undefined
// skips every field, but an explicit null only skips the plain fields - for
// a boolean field, null ? 1 : 0 evaluates to 0, so an explicit null there
// actually sets it to false rather than leaving it alone. Preserved as-is
// rather than "fixed", since this is a faithful migration, not a rewrite.
async function update(id, d) {
  return sequelize.transaction(async (transaction) => {
    const existing = await EquipmentStatus.findByPk(id, { transaction, raw: true });
    if (!existing) return null;
    const oldName = existing.status_name;

    const values = {};
    if (d.status_name !== undefined && d.status_name !== null) values.status_name = d.status_name;
    if (d.description !== undefined && d.description !== null) values.description = d.description;
    if (d.sort_order !== undefined && d.sort_order !== null) values.sort_order = d.sort_order;
    if (d.has_owner !== undefined) values.has_owner = !!d.has_owner;
    if (d.is_assignable !== undefined) values.is_assignable = !!d.is_assignable;
    if (d.is_borrowable !== undefined) values.is_borrowable = !!d.is_borrowable;
    if (d.is_active !== undefined) values.is_active = !!d.is_active;

    let row = existing;
    if (Object.keys(values).length > 0) {
      const [, [updated]] = await EquipmentStatus.update(values, {
        where: { status_id: id },
        returning: true,
        transaction,
      });
      row = updated.get({ plain: true });
    }

    if (d.status_name && d.status_name !== oldName) {
      // Same lazy-require reasoning as findAll()/findById() above - safe
      // here too since this only ever runs once a request is already being
      // handled, long after every model file has finished loading.
      const { Equipment } = require('./equipmentModel');
      await Equipment.update(
        { status: d.status_name },
        { where: { status_id: id }, transaction },
      );
    }

    return row;
  });
}

async function countUsage(id) {
  const { Equipment } = require('./equipmentModel');
  return Equipment.count({ where: { status_id: id } });
}

// Sequelize's destroy() doesn't return the deleted row - fetch first so the
// caller still gets back what was removed.
async function remove(id) {
  const row = await EquipmentStatus.findByPk(id, { raw: true });
  if (!row) return null;
  await EquipmentStatus.destroy({ where: { status_id: id } });
  return row;
}

module.exports = {
  EquipmentStatus, // exported so equipmentModel.js can build associations
  // against this same table definition rather than defining it twice.
  findAll,
  findById,
  findByName,
  create,
  update,
  countUsage,
  remove,
};
