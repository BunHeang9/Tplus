const { DataTypes, fn, col, Op } = require('sequelize');
const sequelize = require('../config/sequelize');
const { PartStock } = require('./partStockModel');

// Custom fields for part types (e.g. Battery -> "Color", "Serial Number"),
// shown when adding/editing a part_stock line.
//
// Mirrors the equipment custom field system exactly, one level down: the
// definition lives in part_custom_field, which part types use it lives in
// part_type_custom_field, and the values (per stock line, not per part type)
// live in part_stock_custom_value. Kept separate from the equipment version
// rather than sharing tables - a device attribute ("Warranty End") and a
// spare-part attribute ("Color") are never meant to be the same field.
//
// Values are stored as text, same tradeoff as the equipment version: no
// numeric sorting or foreign keys, but nothing to migrate when a part type
// gains a field nobody anticipated at launch.

const PartCustomField = sequelize.define('PartCustomField', {
  field_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  field_key: { type: DataTypes.STRING(50), allowNull: false },
  field_label: { type: DataTypes.STRING(100), allowNull: false },
  field_type: { type: DataTypes.STRING(20), allowNull: false },
  // Has its own DB-side default (legacy DATETIME) - let the DB fill it in.
  created_at: { type: DataTypes.DATE, allowNull: true },
  created_by: { type: DataTypes.STRING(50), allowNull: true },
}, {
  tableName: 'part_custom_field',
  schema: 'dbo',
  timestamps: false,
});

// Which part types use which fields - composite primary key, no added_at
// column here (unlike its equipment-side twin, equipment_category_field).
const PartTypeCustomField = sequelize.define('PartTypeCustomField', {
  part_type_id: { type: DataTypes.INTEGER, primaryKey: true },
  field_id: { type: DataTypes.INTEGER, primaryKey: true },
  sort_order: { type: DataTypes.INTEGER, allowNull: false },
  is_required: { type: DataTypes.BOOLEAN, allowNull: false },
}, {
  tableName: 'part_type_custom_field',
  schema: 'dbo',
  timestamps: false,
});

PartTypeCustomField.belongsTo(PartCustomField, { foreignKey: 'field_id', as: 'field' });
PartCustomField.hasMany(PartTypeCustomField, { foreignKey: 'field_id', as: 'partTypeLinks' });

// dbo.part_stock_custom_value's own values (per stock line, not per part
// type).
const PartStockCustomValue = sequelize.define('PartStockCustomValue', {
  stock_id: { type: DataTypes.INTEGER, primaryKey: true },
  field_id: { type: DataTypes.INTEGER, primaryKey: true },
  field_value: { type: DataTypes.STRING(500), allowNull: true },
  updated_at: { type: DataTypes.DATE, allowNull: true },
}, {
  tableName: 'part_stock_custom_value',
  schema: 'dbo',
  timestamps: false,
});
PartStockCustomValue.belongsTo(PartStock, { foreignKey: 'stock_id', as: 'stock' });
PartStockCustomValue.belongsTo(PartCustomField, { foreignKey: 'field_id', as: 'field' });

const FIELD_TYPES = ['text', 'number', 'date', 'boolean'];

// "Serial Number" -> serial_number, so the frontend gets a usable JSON key.
function toKey(label) {
  return String(label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 50);
}

// --- definitions ---

// Every field that exists, with how many part types use it. Feeds the
// picker, so an admin can reuse a field rather than recreating it.
async function findAll() {
  return PartCustomField.findAll({
    attributes: [
      'field_id', 'field_key', 'field_label', 'field_type', 'created_at', 'created_by',
      [fn('COUNT', col('partTypeLinks.field_id')), 'used_by_part_types'],
    ],
    include: [{ model: PartTypeCustomField, as: 'partTypeLinks', attributes: [] }],
    group: [
      'PartCustomField.field_id', 'PartCustomField.field_key', 'PartCustomField.field_label',
      'PartCustomField.field_type', 'PartCustomField.created_at', 'PartCustomField.created_by',
    ],
    order: [['field_label', 'ASC']],
    subQuery: false,
    raw: true,
  });
}

async function findById(fieldId) {
  return PartCustomField.findByPk(fieldId, { raw: true });
}

async function findByKey(fieldKey) {
  return PartCustomField.findOne({ where: { field_key: fieldKey }, raw: true });
}

async function create({ fieldLabel, fieldType, createdBy }) {
  const row = await PartCustomField.create({
    field_key: toKey(fieldLabel),
    field_label: fieldLabel,
    field_type: fieldType || 'text',
    created_by: createdBy || null,
  });
  return row.get({ plain: true });
}

// The key is deliberately not updatable - every stored value is linked to it.
async function update(fieldId, { fieldLabel, fieldType }) {
  const values = {};
  if (fieldLabel !== undefined && fieldLabel !== null) values.field_label = fieldLabel;
  if (fieldType !== undefined && fieldType !== null) values.field_type = fieldType;
  if (Object.keys(values).length === 0) return findById(fieldId);

  const [, [row]] = await PartCustomField.update(values, {
    where: { field_id: fieldId },
    returning: true,
  });
  return row ? row.get({ plain: true }) : null;
}

// Deleting a shared field affects every part type using it, so the caller
// needs to know the scale before confirming.
async function countUsage(fieldId) {
  const [part_type_count, value_count] = await Promise.all([
    PartTypeCustomField.count({ where: { field_id: fieldId } }),
    PartStockCustomValue.count({ where: { field_id: fieldId, field_value: { [Op.ne]: null } } }),
  ]);
  return { part_type_count, value_count };
}

// Sequelize's destroy() doesn't return the deleted row - fetch first so the
// caller still gets back what was removed.
async function remove(fieldId) {
  const row = await PartCustomField.findByPk(fieldId, { raw: true });
  if (!row) return null;
  await PartCustomField.destroy({ where: { field_id: fieldId } });
  return row;
}

// --- which part types use which fields ---

async function findByPartType(partTypeId) {
  const rows = await PartTypeCustomField.findAll({
    where: { part_type_id: partTypeId },
    include: [{ model: PartCustomField, as: 'field' }],
    order: [['sort_order', 'ASC'], [{ model: PartCustomField, as: 'field' }, 'field_id', 'ASC']],
  });
  return rows.map((row) => {
    const { field, sort_order, is_required } = row.get({ plain: true });
    return {
      field_id: field.field_id,
      field_key: field.field_key,
      field_label: field.field_label,
      field_type: field.field_type,
      sort_order,
      is_required,
    };
  });
}

// One query for every part type at once - GET /api/part-types needs each
// row's fields without a query per part type.
async function findByPartTypes(partTypeIds) {
  if (!partTypeIds || partTypeIds.length === 0) return {};

  const rows = await PartTypeCustomField.findAll({
    where: { part_type_id: { [Op.in]: partTypeIds } },
    include: [{ model: PartCustomField, as: 'field', required: true }],
    order: [['sort_order', 'ASC'], [{ model: PartCustomField, as: 'field' }, 'field_id', 'ASC']],
  });

  const byPartType = {};
  for (const row of rows) {
    const { field, part_type_id, sort_order, is_required } = row.get({ plain: true });
    if (!byPartType[part_type_id]) byPartType[part_type_id] = [];
    byPartType[part_type_id].push({
      part_type_id,
      field_id: field.field_id,
      field_key: field.field_key,
      field_label: field.field_label,
      field_type: field.field_type,
      sort_order,
      is_required,
    });
  }
  return byPartType;
}

// Attaching an existing field to a part type - the reuse case. upsert() so
// calling it twice updates the order rather than failing on the primary key
// - sort_order/is_required are always set to the given (or defaulted) value
// either way, a real upsert rather than a MERGE...COALESCE situation.
async function attachToPartType(partTypeId, fieldId, { sortOrder, isRequired } = {}) {
  const [row] = await PartTypeCustomField.upsert({
    part_type_id: partTypeId,
    field_id: fieldId,
    sort_order: sortOrder ?? 99,
    is_required: !!isRequired,
  }, { returning: true });
  // The mssql dialect's upsert() adds an internal $action column from its
  // MERGE OUTPUT that the raw version's OUTPUT INSERTED.* never had.
  const plain = row.get({ plain: true });
  delete plain.$action;
  return plain;
}

// Removes the field from one part type only. The definition and any values
// on other part types are untouched.
async function detachFromPartType(partTypeId, fieldId) {
  const row = await PartTypeCustomField.findOne({
    where: { part_type_id: partTypeId, field_id: fieldId },
    raw: true,
  });
  if (!row) return null;
  await PartTypeCustomField.destroy({ where: { part_type_id: partTypeId, field_id: fieldId } });
  return row;
}

async function countValuesForPartType(partTypeId, fieldId) {
  return PartStockCustomValue.count({
    where: { field_id: fieldId, field_value: { [Op.ne]: null } },
    include: [{ model: PartStock, as: 'stock', attributes: [], where: { part_type_id: partTypeId }, required: true }],
  });
}

// --- values ---

// The join key (a specific stock line's part type, joined against its
// stored values) isn't a plain FK a static association can express, so this
// reuses findByPartType() above (every field attached to this line's part
// type, already ORM) merged in JS with this one stock line's own stored
// values - not a fan-out risk since both reads are scoped to exactly one
// stock_id.
async function getValues(stockId) {
  const stock = await PartStock.findByPk(stockId, { attributes: ['part_type_id'], raw: true });
  if (!stock) return [];

  const [fields, values] = await Promise.all([
    findByPartType(stock.part_type_id),
    PartStockCustomValue.findAll({ where: { stock_id: stockId }, raw: true }),
  ]);
  const valueByFieldId = new Map(values.map((v) => [v.field_id, v.field_value]));

  return fields.map((f) => ({
    field_key: f.field_key,
    field_label: f.field_label,
    field_type: f.field_type,
    field_value: valueByFieldId.has(f.field_id) ? valueByFieldId.get(f.field_id) : null,
  }));
}

// One query for a whole stock list rather than one per row.
async function getValuesForMany(stockIds) {
  if (!stockIds || stockIds.length === 0) return {};

  // The original raw query had no ORDER BY, so its row/key order was
  // already undefined - ordering here just makes this version deterministic.
  const rows = await PartStockCustomValue.findAll({
    where: { stock_id: { [Op.in]: stockIds } },
    include: [{ model: PartCustomField, as: 'field', attributes: ['field_key'] }],
    order: [['stock_id', 'ASC'], [{ model: PartCustomField, as: 'field' }, 'field_key', 'ASC']],
  });

  const byStock = {};
  for (const row of rows) {
    const { stock_id, field, field_value } = row.get({ plain: true });
    if (!byStock[stock_id]) byStock[stock_id] = {};
    byStock[stock_id][field.field_key] = field_value;
  }
  return byStock;
}

// MERGE because a stock line may have no row yet for a field added after it
// was created. The join checks the field is actually attached to the line's
// part type, so a value cannot be stored against a field that part type does
// not use.
//
// The "field exists AND is attached to this line's part type" gate was one
// atomic MERGE...USING before; here it's an explicit lookup chain (field ->
// attachment -> existing value) ahead of a plain update-or-create, same
// pattern as its equipment-side twin (customFieldModel.setValues). Accepts
// an optional external Sequelize transaction, for consistency and forward
// compatibility even though today's callers (partStockController.js) don't
// currently pass one. updated_at is only set on the update branch, matching
// the original MERGE's INSERT column list, which never included it.
async function setValues(stockId, values, transaction) {
  const entries = Object.entries(values || {});
  if (entries.length === 0) return;

  const stock = await PartStock.findByPk(stockId, { attributes: ['part_type_id'], transaction, raw: true });
  if (!stock) return;

  for (const [key, value] of entries) {
    const field = await PartCustomField.findOne({
      where: { field_key: key }, attributes: ['field_id'], transaction, raw: true,
    });
    if (!field) continue;

    const attached = await PartTypeCustomField.findOne({
      where: { part_type_id: stock.part_type_id, field_id: field.field_id }, transaction, raw: true,
    });
    if (!attached) continue;

    const field_value = value === null || value === undefined ? null : String(value);
    const existing = await PartStockCustomValue.findOne({
      where: { stock_id: stockId, field_id: field.field_id }, transaction,
    });

    if (existing) {
      await existing.update({ field_value, updated_at: fn('GETDATE') }, { transaction });
    } else {
      await PartStockCustomValue.create({ stock_id: stockId, field_id: field.field_id, field_value }, { transaction });
    }
  }
}

module.exports = {
  PartStockCustomValue,
  FIELD_TYPES, toKey,
  findAll, findById, findByKey, create, update, countUsage, remove,
  findByPartType, findByPartTypes, attachToPartType, detachFromPartType, countValuesForPartType,
  getValues, getValuesForMany, setValues,
};
