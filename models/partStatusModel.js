const { DataTypes, fn, col } = require('sequelize');
const sequelize = require('../config/sequelize');

// Statuses a spare part (dbo.part_stock) can be in - the part-side twin of
// statusModel.js's equipment_status, one level simpler: a loose component
// has no owner and is never "assigned" to a person the way a device is, so
// there's no has_owner/is_assignable here - only is_borrowable, since parts
// genuinely do get borrowed (mice, keyboards, bags...), driving
// partBorrowModel's borrow-eligibility check the same way is_borrowable
// already drives equipment's own borrow eligibility.
//
// part_stock.status is a foreign key straight to this table's status_name
// (not a status_id + denormalized text pair the way equipment does it) with
// ON UPDATE CASCADE - renaming a status here propagates to every part_stock
// row using it automatically at the database level, so update() below
// doesn't need the manual "propagate the rename" transaction statusModel.js's
// own update() needs for equipment.status.
const PartStockStatus = sequelize.define('PartStockStatus', {
  status_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  status_name: { type: DataTypes.STRING(50), allowNull: false },
  description: { type: DataTypes.STRING(255), allowNull: true },
  is_borrowable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  sort_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 99 },
  is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  // Has its own DB-side default - allowNull:true here is not the real
  // schema, same reasoning as every other created_at column in this project:
  // it only stops Sequelize validating a value into existence client-side.
  created_at: { type: DataTypes.DATE, allowNull: true },
}, {
  tableName: 'part_stock_status',
  schema: 'dbo',
  timestamps: false,
});

// stock_count needs PartStock, and partStockModel.js already imports
// PartStockStatus from this file at ITS top level (for its own belongsTo) -
// so this file importing PartStock back at ITS OWN top level would be a
// real require cycle. Lazy instead (inside the function body, evaluated
// only when the function actually runs, long after the whole app has
// finished starting up and every model file is already loaded) - same
// technique as statusModel.js/categoryModel.js/departmentModel.js's own
// correlated counts.
//
// part_stock.status is a foreign key to status_name (not status_id), so
// the join/count key is the name, not the id - see this file's own header
// comment on PartStockStatus for why.
async function findAll(includeInactive = false) {
  const { PartStock } = require('./partStockModel');

  const counts = await PartStock.findAll({
    attributes: ['status', [fn('COUNT', col('stock_id')), 'n']],
    group: ['status'],
    raw: true,
  });
  const countByStatusName = new Map(counts.map((r) => [r.status, r.n]));

  const statuses = await PartStockStatus.findAll({
    where: includeInactive ? {} : { is_active: true },
    order: [['sort_order', 'ASC'], ['status_id', 'ASC']],
    raw: true,
  });
  return statuses.map((s) => ({
    status_id: s.status_id,
    status_name: s.status_name,
    description: s.description,
    is_borrowable: s.is_borrowable,
    sort_order: s.sort_order,
    is_active: s.is_active,
    stock_count: countByStatusName.get(s.status_name) || 0,
  }));
}

async function findById(id) {
  const { PartStock } = require('./partStockModel');

  const row = await PartStockStatus.findByPk(id, { raw: true });
  if (!row) return null;
  const stock_count = await PartStock.count({ where: { status: row.status_name } });
  return { ...row, stock_count };
}

async function findByName(name) {
  return PartStockStatus.findOne({ where: { status_name: name }, raw: true });
}

async function create(d) {
  const row = await PartStockStatus.create({
    status_name: d.status_name,
    description: d.description || null,
    is_borrowable: !!d.is_borrowable,
    sort_order: d.sort_order ?? 99,
  });
  return row.get({ plain: true });
}

// Renaming cascades to part_stock.status on its own (ON UPDATE CASCADE on
// the FK) - no transaction/manual propagation needed here, unlike
// statusModel.js's own update().
async function update(id, d) {
  const values = {};
  if (d.status_name !== undefined && d.status_name !== null) values.status_name = d.status_name;
  if (d.description !== undefined && d.description !== null) values.description = d.description;
  if (d.sort_order !== undefined && d.sort_order !== null) values.sort_order = d.sort_order;
  if (d.is_borrowable !== undefined) values.is_borrowable = !!d.is_borrowable;
  if (d.is_active !== undefined) values.is_active = !!d.is_active;

  if (Object.keys(values).length === 0) return findById(id);

  const [, [row]] = await PartStockStatus.update(values, {
    where: { status_id: id },
    returning: true,
  });
  return row ? row.get({ plain: true }) : null;
}

async function countUsage(id) {
  const { PartStock } = require('./partStockModel');

  const status = await PartStockStatus.findByPk(id, { attributes: ['status_name'], raw: true });
  if (!status) return 0;
  return PartStock.count({ where: { status: status.status_name } });
}

// Sequelize's destroy() doesn't return the deleted row - fetch first so the
// caller still gets back what was removed.
async function remove(id) {
  const row = await PartStockStatus.findByPk(id, { raw: true });
  if (!row) return null;
  await PartStockStatus.destroy({ where: { status_id: id } });
  return row;
}

module.exports = {
  PartStockStatus,
  findAll, findById, findByName, create, update, countUsage, remove,
};
