const { DataTypes, fn, col } = require('sequelize');
const sequelize = require('../config/sequelize');

// Reference table: dbo.category (Laptop, Desktop, PC, Server, Monitor, CCTV, ...)

const Category = sequelize.define('Category', {
  category_id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  category_name: {
    type: DataTypes.STRING(50),
    allowNull: false,
  },
  description: {
    type: DataTypes.STRING(255),
    allowNull: true,
  },
  is_active: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true,
  },
  // Has its own DB-side default, same as the original raw INSERT relied on
  // (it never set this column either). allowNull: true here is not the
  // real schema - it only stops Sequelize validating a value into
  // existence client-side. With no defaultValue and nothing passed to
  // create(), Sequelize omits this column from the INSERT entirely and
  // the DB default fills it in - the same server clock the raw SQL
  // version used, not Sequelize's own date formatting (which sends a
  // timezone-offset suffix plain DATETIME columns reject; this table's
  // created_at is legacy DATETIME, not DATETIME2).
  created_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  view_key: {
    type: DataTypes.STRING(50),
    allowNull: true,
  },
}, {
  tableName: 'category',
  schema: 'dbo',
  timestamps: false,
});

function toViewKey(name) {
  return name.toLowerCase().replace(/ /g, '-').replace(/_/g, '-');
}

// equipment_count needs Equipment, and equipmentModel.js already imports
// Category from this file at ITS top level (for its own belongsTo) - so
// this file importing Equipment back at ITS OWN top level would be a real
// require cycle. Lazy instead (inside the function body, evaluated only
// when the function actually runs): by the time any request handler calls
// findAll(), the whole app has already finished starting up and every
// model file is already loaded, so this just returns the cached module.
// Same technique as departmentModel.js's own findAll()/countUsage().
async function findAll() {
  const { Equipment } = require('./equipmentModel');

  const counts = await Equipment.findAll({
    attributes: ['category_id', [fn('COUNT', col('equipment_id')), 'n']],
    group: ['category_id'],
    raw: true,
  });
  const countByCategory = new Map(counts.map((r) => [r.category_id, r.n]));

  const categories = await Category.findAll({ order: [['category_name', 'ASC']], raw: true });
  return categories.map((c) => ({
    category_id: c.category_id,
    category_name: c.category_name,
    description: c.description,
    is_active: c.is_active,
    equipment_count: countByCategory.get(c.category_id) || 0,
  }));
}

async function findById(id) {
  return Category.findByPk(id, { raw: true });
}

async function findByName(name) {
  return Category.findOne({ where: { category_name: name }, raw: true });
}

async function create({ category_name, description }) {
  const row = await Category.create({
    category_name,
    description: description || null,
    // Generated from the name so /api/equipment/network-device works.
    // Without this a new category has no reachable view.
    view_key: toViewKey(category_name),
  });
  return row.get({ plain: true });
}

async function update(id, { category_name, description, is_active }) {
  const values = {};
  if (category_name !== undefined) {
    values.category_name = category_name;
    // Regenerated on rename so the URL keeps matching the name - otherwise
    // a category renamed to "Testing" would still be served at
    // /api/equipment/test. Only changes when the name does.
    values.view_key = toViewKey(category_name);
  }
  if (description !== undefined) values.description = description;
  if (is_active !== undefined) values.is_active = is_active;

  if (Object.keys(values).length === 0) return findById(id);

  const [, [row]] = await Category.update(values, {
    where: { category_id: id },
    returning: true,
  });
  return row ? row.get({ plain: true }) : null;
}

// Not this table's own row count - dbo.equipment's. Same lazy-require
// reasoning as findAll() above.
async function countUsage(id) {
  const { Equipment } = require('./equipmentModel');
  const equipment_count = await Equipment.count({ where: { category_id: id } });
  return { equipment_count };
}

// Sequelize's destroy() doesn't return the deleted row (no OUTPUT DELETED.*
// equivalent) - fetch first so the caller still gets back what was removed.
async function remove(id) {
  const row = await Category.findByPk(id, { raw: true });
  if (!row) return null;
  await Category.destroy({ where: { category_id: id } });
  return row;
}

module.exports = {
  Category, // exported so viewColumnModel.js can reuse this same table
  // definition (findCategoryByViewKey) rather than defining it twice.
  findAll, findById, findByName, create, update, countUsage, remove,
};
