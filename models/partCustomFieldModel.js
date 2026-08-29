const sequelize = require('../config/sequelize');
const { QueryTypes } = require('sequelize');
const { PartCustomField, PartTypeCustomField } = require('./sequelize/partCustomFieldModel');

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
  return sequelize.query(`
    SELECT f.field_id, f.field_key, f.field_label, f.field_type,
           f.created_at, f.created_by,
           (SELECT COUNT(*) FROM dbo.part_type_custom_field tf
             WHERE tf.field_id = f.field_id) AS used_by_part_types
    FROM dbo.part_custom_field f
    ORDER BY f.field_label
  `, { type: QueryTypes.SELECT });
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
  const [row] = await sequelize.query(`
    SELECT
      (SELECT COUNT(*) FROM dbo.part_type_custom_field WHERE field_id = :id) AS part_type_count,
      (SELECT COUNT(*) FROM dbo.part_stock_custom_value
        WHERE field_id = :id AND field_value IS NOT NULL) AS value_count
  `, { replacements: { id: fieldId }, type: QueryTypes.SELECT });
  return row;
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
  return sequelize.query(`
    SELECT f.field_id, f.field_key, f.field_label, f.field_type,
           tf.sort_order, tf.is_required
    FROM dbo.part_type_custom_field tf
    JOIN dbo.part_custom_field f ON tf.field_id = f.field_id
    WHERE tf.part_type_id = :part_type_id
    ORDER BY tf.sort_order, f.field_id
  `, { replacements: { part_type_id: partTypeId }, type: QueryTypes.SELECT });
}

// One query for every part type at once - GET /api/part-types needs each
// row's fields without a query per part type.
async function findByPartTypes(partTypeIds) {
  if (!partTypeIds || partTypeIds.length === 0) return {};

  const rows = await sequelize.query(`
    SELECT tf.part_type_id, f.field_id, f.field_key, f.field_label, f.field_type,
           tf.sort_order, tf.is_required
    FROM dbo.part_type_custom_field tf
    JOIN dbo.part_custom_field f ON tf.field_id = f.field_id
    WHERE tf.part_type_id IN (:ids)
    ORDER BY tf.sort_order, f.field_id
  `, { replacements: { ids: partTypeIds }, type: QueryTypes.SELECT });

  const byPartType = {};
  for (const row of rows) {
    if (!byPartType[row.part_type_id]) byPartType[row.part_type_id] = [];
    byPartType[row.part_type_id].push(row);
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
  const [row] = await sequelize.query(`
    SELECT COUNT(*) AS value_count
    FROM dbo.part_stock_custom_value v
    JOIN dbo.part_stock s ON v.stock_id = s.stock_id
    WHERE v.field_id = :field_id AND s.part_type_id = :part_type_id
      AND v.field_value IS NOT NULL
  `, { replacements: { part_type_id: partTypeId, field_id: fieldId }, type: QueryTypes.SELECT });
  return row.value_count;
}

// --- values ---

async function getValues(stockId) {
  return sequelize.query(`
    SELECT f.field_key, f.field_label, f.field_type, v.field_value
    FROM dbo.part_stock s
    JOIN dbo.part_type_custom_field tf ON tf.part_type_id = s.part_type_id
    JOIN dbo.part_custom_field f ON tf.field_id = f.field_id
    LEFT JOIN dbo.part_stock_custom_value v
           ON v.field_id = f.field_id AND v.stock_id = s.stock_id
    WHERE s.stock_id = :stock_id
    ORDER BY tf.sort_order, f.field_id
  `, { replacements: { stock_id: stockId }, type: QueryTypes.SELECT });
}

// One query for a whole stock list rather than one per row.
async function getValuesForMany(stockIds) {
  if (!stockIds || stockIds.length === 0) return {};

  const rows = await sequelize.query(`
    SELECT v.stock_id, f.field_key, v.field_value
    FROM dbo.part_stock_custom_value v
    JOIN dbo.part_custom_field f ON v.field_id = f.field_id
    WHERE v.stock_id IN (:ids)
  `, { replacements: { ids: stockIds }, type: QueryTypes.SELECT });

  const byStock = {};
  for (const row of rows) {
    if (!byStock[row.stock_id]) byStock[row.stock_id] = {};
    byStock[row.stock_id][row.field_key] = row.field_value;
  }
  return byStock;
}

// MERGE because a stock line may have no row yet for a field added after it
// was created. The join checks the field is actually attached to the line's
// part type, so a value cannot be stored against a field that part type does
// not use.
//
// Accepts an optional external Sequelize transaction, same as its
// equipment-side twin (customFieldModel.setValues) - for consistency and
// forward compatibility even though today's callers (partStockController.js)
// don't currently pass one.
async function setValues(stockId, values, transaction) {
  const entries = Object.entries(values || {});
  if (entries.length === 0) return;

  for (const [key, value] of entries) {
    await sequelize.query(`
        MERGE dbo.part_stock_custom_value AS target
        USING (
            SELECT :stock_id AS stock_id, f.field_id
            FROM dbo.part_custom_field f
            JOIN dbo.part_type_custom_field tf ON tf.field_id = f.field_id
            JOIN dbo.part_stock s ON s.part_type_id = tf.part_type_id
            WHERE s.stock_id = :stock_id AND f.field_key = :field_key
        ) AS source
        ON target.stock_id = source.stock_id AND target.field_id = source.field_id
        WHEN MATCHED THEN
            UPDATE SET field_value = :field_value, updated_at = GETDATE()
        WHEN NOT MATCHED THEN
            INSERT (stock_id, field_id, field_value)
            VALUES (source.stock_id, source.field_id, :field_value);
      `, {
      replacements: {
        stock_id: stockId,
        field_key: key,
        field_value: value === null || value === undefined ? null : String(value),
      },
      transaction,
    });
  }
}

module.exports = {
  FIELD_TYPES, toKey,
  findAll, findById, findByKey, create, update, countUsage, remove,
  findByPartType, findByPartTypes, attachToPartType, detachFromPartType, countValuesForPartType,
  getValues, getValuesForMany, setValues,
};
