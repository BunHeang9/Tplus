const { DataTypes, Op } = require('sequelize');
const sequelize = require('../config/sequelize');

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
// No Sequelize model maps 1:1 onto "every column of an arbitrary table" the
// way describeTable() does, so this uses that Sequelize QueryInterface API
// (introspection through the ORM, not a hand-written SELECT) rather than
// INFORMATION_SCHEMA directly. describeTable()'s key order matches
// ORDINAL_POSITION (confirmed live), and its "type" comes back as e.g.
// "NVARCHAR(100)" where the old INFORMATION_SCHEMA.DATA_TYPE gave "nvarchar"
// - normalized (strip the length/precision, lowercase) to keep the same
// data_type strings any existing caller already depends on.
async function describePartStockColumns() {
  return sequelize.getQueryInterface().describeTable({ tableName: 'part_stock', schema: 'dbo' });
}

async function validStockFields() {
  const desc = await describePartStockColumns();
  return Object.keys(desc)
    .filter((name) => !HIDDEN_FROM_PICKER.has(name))
    .map((name) => ({
      field: name,
      suggested_header: SUGGESTED_HEADERS[name]
        || name.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase()),
      data_type: desc[name].type.split('(')[0].toLowerCase(),
    }));
}

// Used to reject a field_name that is not a real column - without this a
// typo would produce a form whose every save silently drops that field.
async function isValidStockField(fieldName) {
  const desc = await describePartStockColumns();
  return Object.prototype.hasOwnProperty.call(desc, fieldName);
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
