const { DataTypes } = require('sequelize');
const sequelize = require('../config/sequelize');
const { QueryTypes } = require('sequelize');

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

// Correlated subquery for equipment_count - a reporting-style read, not a
// fit for .findAll(), so raw query through Sequelize.
async function findAll() {
  return sequelize.query(`
    SELECT c.category_id, c.category_name, c.description, c.is_active,
           (SELECT COUNT(*) FROM dbo.equipment e WHERE e.category_id = c.category_id) AS equipment_count
    FROM dbo.category c
    ORDER BY c.category_name
  `, { type: QueryTypes.SELECT });
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

// Not this table's own row count - dbo.equipment's, so a raw query rather
// than forcing an Equipment model into existence early for one COUNT.
async function countUsage(id) {
  const [row] = await sequelize.query(
    'SELECT COUNT(*) AS equipment_count FROM dbo.equipment WHERE category_id = :id',
    { replacements: { id }, type: QueryTypes.SELECT },
  );
  return row;
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
