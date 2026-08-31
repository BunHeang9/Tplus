const { DataTypes, Op } = require('sequelize');
const sequelize = require('../config/sequelize');
const { QueryTypes } = require('sequelize');

// Which part_stock columns each part type's Add/Edit Stock form shows
// (dbo.part_type_stock_column).
//
// Mirrors viewColumnModel.js exactly, one level down: that configures which
// dbo.equipment columns a category's view shows; this configures which
// dbo.part_stock columns a part type's stock form shows. Custom fields are
// the separate, already-built part_type_custom_field system - this is only
// for the built-in columns (model_name, location, quantity, disk_type...),
// selectable per part type instead of every part showing every column.

const PartTypeStockColumn = sequelize.define('PartTypeStockColumn', {
  view_column_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  part_type_id: { type: DataTypes.INTEGER, allowNull: false },
  field_name: { type: DataTypes.STRING(50), allowNull: false },
  header_text: { type: DataTypes.STRING(100), allowNull: false },
  sort_order: { type: DataTypes.INTEGER, allowNull: false },
}, {
  tableName: 'part_type_stock_column',
  schema: 'dbo',
  timestamps: false,
});

const HIDDEN_FROM_PICKER = new Set(['stock_id', 'part_type_id']);

const SUGGESTED_HEADERS = {
  part_value: 'Value',
  model_name: 'Model Name',
  model_number: 'Model Number',
  disk_type: 'Disk Type',
  disk_interface: 'Disk Interface',
  ram_type: 'RAM Type',
  status: 'Status',
  quantity: 'Quantity',
  location: 'Location',
  remark: 'Remark',
  is_active: 'Active',
  updated_at: 'Last Updated',
};

// Every part_stock column an admin can choose from, read live from the
// schema so a column added later shows up without touching this file.
// INFORMATION_SCHEMA introspection - raw query, not an ORM model.
async function validStockFields() {
  const cols = await sequelize.query(`
    SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = 'part_stock' AND TABLE_SCHEMA = 'dbo'
    ORDER BY ORDINAL_POSITION
  `, { type: QueryTypes.SELECT });
  return cols
    .filter((c) => !HIDDEN_FROM_PICKER.has(c.COLUMN_NAME))
    .map((c) => ({
      field: c.COLUMN_NAME,
      suggested_header: SUGGESTED_HEADERS[c.COLUMN_NAME]
        || c.COLUMN_NAME.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase()),
      data_type: c.DATA_TYPE,
    }));
}

// Used to reject a field_name that is not a real column - without this a
// typo would produce a form whose every save silently drops that field.
async function isValidStockField(fieldName) {
  const [row] = await sequelize.query(`
    SELECT 1 AS ok FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = 'part_stock' AND TABLE_SCHEMA = 'dbo' AND COLUMN_NAME = :field
  `, { replacements: { field: fieldName }, type: QueryTypes.SELECT });
  return !!row;
}

async function findByPartType(partTypeId) {
  return PartTypeStockColumn.findAll({
    where: { part_type_id: partTypeId },
    order: [['sort_order', 'ASC'], ['view_column_id', 'ASC']],
    raw: true,
  });
}

// One query for every part type at once - GET /api/part-types needs each
// row's columns without a query per part type.
async function findByPartTypes(partTypeIds) {
  if (!partTypeIds || partTypeIds.length === 0) return {};

  const rows = await PartTypeStockColumn.findAll({
    attributes: ['part_type_id', 'field_name', 'header_text', 'sort_order'],
    where: { part_type_id: { [Op.in]: partTypeIds } },
    order: [['sort_order', 'ASC']],
    raw: true,
  });

  const byPartType = {};
  for (const row of rows) {
    if (!byPartType[row.part_type_id]) byPartType[row.part_type_id] = [];
    byPartType[row.part_type_id].push(row);
  }
  return byPartType;
}

// Replaces the whole set for a part type in one transaction - a half-saved
// list would leave the form half-configured if something failed midway.
async function replaceColumns(partTypeId, columns) {
  await sequelize.transaction(async (transaction) => {
    await PartTypeStockColumn.destroy({ where: { part_type_id: partTypeId }, transaction });

    if (columns.length > 0) {
      await PartTypeStockColumn.bulkCreate(
        columns.map((col, i) => ({
          part_type_id: partTypeId,
          field_name: col.field,
          header_text: col.header,
          sort_order: i + 1,
        })),
        { transaction },
      );
    }
  });
  return findByPartType(partTypeId);
}

module.exports = {
  validStockFields, isValidStockField,
  findByPartType, findByPartTypes, replaceColumns,
};
