const { DataTypes } = require('sequelize');
const sequelize = require('../config/sequelize');
const { QueryTypes } = require('sequelize');

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

// Correlated subquery for stock_count - this file is required BY
// partStockModel.js (for the belongsTo association declared there), so it
// can never import PartStock back without a require cycle, the same
// circularity statusModel.js has relative to equipmentModel.js.
async function findAll(includeInactive = false) {
  let query = `
    SELECT s.status_id, s.status_name, s.description, s.is_borrowable,
           s.sort_order, s.is_active,
           (SELECT COUNT(*) FROM dbo.part_stock p WHERE p.status = s.status_name) AS stock_count
    FROM dbo.part_stock_status s
  `;
  if (!includeInactive) query += ' WHERE s.is_active = 1';
  query += ' ORDER BY s.sort_order, s.status_id';
  return sequelize.query(query, { type: QueryTypes.SELECT });
}

async function findById(id) {
  const [row] = await sequelize.query(`
    SELECT s.*, (SELECT COUNT(*) FROM dbo.part_stock p WHERE p.status = s.status_name) AS stock_count
    FROM dbo.part_stock_status s WHERE s.status_id = :id
  `, { replacements: { id }, type: QueryTypes.SELECT });
  return row || null;
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
  const [row] = await sequelize.query(`
    SELECT COUNT(*) AS n FROM dbo.part_stock p
    JOIN dbo.part_stock_status s ON p.status = s.status_name
    WHERE s.status_id = :id
  `, { replacements: { id }, type: QueryTypes.SELECT });
  return row.n;
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
