const { DataTypes } = require('sequelize');
const sequelize = require('../config/sequelize');
const { QueryTypes } = require('sequelize');

// Custom fields are defined once and shared across categories.
//
// The first version tied each field to one category, so "Warranty End" on two
// categories meant two unrelated fields with separate storage. Now the
// definition lives in equipment_custom_field, which categories use it lives in
// equipment_category_field, and the values in equipment_custom_value.
//
// Values are stored as text. That is the cost of keeping these out of
// dbo.equipment - no numeric sorting, no foreign keys. A field you would total
// or filter on heavily still deserves a real column.

// The field definition itself (dbo.equipment_custom_field).
const EquipmentCustomField = sequelize.define('EquipmentCustomField', {
  field_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  field_key: { type: DataTypes.STRING(50), allowNull: false },
  field_label: { type: DataTypes.STRING(100), allowNull: false },
  field_type: { type: DataTypes.STRING(20), allowNull: false },
  // Has its own DB-side default (legacy DATETIME) - let the DB fill it in,
  // same reasoning as every other table with this pattern in this migration.
  created_at: { type: DataTypes.DATE, allowNull: true },
  created_by: { type: DataTypes.STRING(100), allowNull: true },
}, {
  tableName: 'equipment_custom_field',
  schema: 'dbo',
  timestamps: false,
});

// Which categories use which fields (dbo.equipment_category_field) -
// composite primary key, no identity column of its own.
const EquipmentCategoryField = sequelize.define('EquipmentCategoryField', {
  category_id: { type: DataTypes.INTEGER, primaryKey: true },
  field_id: { type: DataTypes.INTEGER, primaryKey: true },
  sort_order: { type: DataTypes.INTEGER, allowNull: false },
  is_required: { type: DataTypes.BOOLEAN, allowNull: false },
  added_at: { type: DataTypes.DATE, allowNull: true },
}, {
  tableName: 'equipment_category_field',
  schema: 'dbo',
  timestamps: false,
});

// The stored values themselves (dbo.equipment_custom_value) - also a
// composite primary key. Only used for reads here; writes stay in
// setValues() below (raw SQL, see the comment there).
const EquipmentCustomValue = sequelize.define('EquipmentCustomValue', {
  equipment_id: { type: DataTypes.INTEGER, primaryKey: true },
  field_id: { type: DataTypes.INTEGER, primaryKey: true },
  field_value: { type: DataTypes.STRING(500), allowNull: true },
  updated_at: { type: DataTypes.DATE, allowNull: true },
}, {
  tableName: 'equipment_custom_value',
  schema: 'dbo',
  timestamps: false,
});

EquipmentCategoryField.belongsTo(EquipmentCustomField, { foreignKey: 'field_id', as: 'field' });

const FIELD_TYPES = ['text', 'number', 'date', 'boolean'];

// "Warranty End" -> warranty_end, so the frontend gets a usable JSON key.
function toKey(label) {
  return String(label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 50);
}

// --- definitions ---

// Every field that exists, with how many categories use it. Feeds the picker,
// so an admin can reuse a field rather than recreating it. Correlated
// subquery - raw query through Sequelize.
async function findAll() {
  return sequelize.query(`
    SELECT f.field_id, f.field_key, f.field_label, f.field_type,
           f.created_at, f.created_by,
           (SELECT COUNT(*) FROM dbo.equipment_category_field cf
             WHERE cf.field_id = f.field_id) AS used_by_categories
    FROM dbo.equipment_custom_field f
    ORDER BY f.field_label
  `, { type: QueryTypes.SELECT });
}

async function findById(fieldId) {
  return EquipmentCustomField.findByPk(fieldId, { raw: true });
}

async function findByKey(fieldKey) {
  return EquipmentCustomField.findOne({ where: { field_key: fieldKey }, raw: true });
}

async function create({ fieldLabel, fieldType, createdBy }) {
  const row = await EquipmentCustomField.create({
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

  const [, [row]] = await EquipmentCustomField.update(values, {
    where: { field_id: fieldId },
    returning: true,
  });
  return row ? row.get({ plain: true }) : null;
}

// Deleting a shared field affects every category using it, so the caller needs
// to know the scale before confirming.
async function countUsage(fieldId) {
  const [row] = await sequelize.query(`
    SELECT
      (SELECT COUNT(*) FROM dbo.equipment_category_field WHERE field_id = :id) AS category_count,
      (SELECT COUNT(*) FROM dbo.equipment_custom_value
        WHERE field_id = :id AND field_value IS NOT NULL) AS value_count
  `, { replacements: { id: fieldId }, type: QueryTypes.SELECT });
  return row;
}

// Sequelize's destroy() doesn't return the deleted row - fetch first so the
// caller still gets back what was removed.
async function remove(fieldId) {
  const row = await EquipmentCustomField.findByPk(fieldId, { raw: true });
  if (!row) return null;
  await EquipmentCustomField.destroy({ where: { field_id: fieldId } });
  return row;
}

// --- which categories use which fields ---

async function findByCategory(categoryId) {
  const rows = await EquipmentCategoryField.findAll({
    where: { category_id: categoryId },
    include: [{ model: EquipmentCustomField, as: 'field' }],
    order: [['sort_order', 'ASC'], [{ model: EquipmentCustomField, as: 'field' }, 'field_id', 'ASC']],
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

// Attaching an existing field to a category - the reuse case. upsert() so
// calling it twice updates the order rather than failing on the primary key
// - sort_order/is_required are always set to the given (or defaulted) value
// either way, never merged with what was there before, so this is a real
// upsert rather than a MERGE...COALESCE situation.
async function attachToCategory(categoryId, fieldId, { sortOrder, isRequired } = {}) {
  const [row] = await EquipmentCategoryField.upsert({
    category_id: categoryId,
    field_id: fieldId,
    sort_order: sortOrder ?? 99,
    is_required: !!isRequired,
  }, { returning: true });
  // The mssql dialect's upsert() adds an internal $action ('INSERT'/'UPDATE')
  // column from its MERGE OUTPUT that the raw version's OUTPUT INSERTED.*
  // never had - stripped so the response shape is unchanged.
  const plain = row.get({ plain: true });
  delete plain.$action;
  return plain;
}

// Removes the field from one category only. The definition and any values on
// other categories are untouched.
async function detachFromCategory(categoryId, fieldId) {
  const row = await EquipmentCategoryField.findOne({
    where: { category_id: categoryId, field_id: fieldId },
    raw: true,
  });
  if (!row) return null;
  await EquipmentCategoryField.destroy({ where: { category_id: categoryId, field_id: fieldId } });
  return row;
}

async function countValuesInCategory(categoryId, fieldId) {
  const [row] = await sequelize.query(`
    SELECT COUNT(*) AS value_count
    FROM dbo.equipment_custom_value v
    JOIN dbo.equipment e ON v.equipment_id = e.equipment_id
    WHERE v.field_id = :field_id AND e.category_id = :category_id
      AND v.field_value IS NOT NULL
  `, { replacements: { category_id: categoryId, field_id: fieldId }, type: QueryTypes.SELECT });
  return row.value_count;
}

// --- values ---

async function getValues(equipmentId) {
  return sequelize.query(`
    SELECT f.field_key, f.field_label, f.field_type, v.field_value
    FROM dbo.equipment e
    JOIN dbo.equipment_category_field cf ON cf.category_id = e.category_id
    JOIN dbo.equipment_custom_field f ON cf.field_id = f.field_id
    LEFT JOIN dbo.equipment_custom_value v
           ON v.field_id = f.field_id AND v.equipment_id = e.equipment_id
    WHERE e.equipment_id = :equipment_id
    ORDER BY cf.sort_order, f.field_id
  `, { replacements: { equipment_id: equipmentId }, type: QueryTypes.SELECT });
}

// One query for a whole page rather than one per row.
async function getValuesForMany(equipmentIds) {
  if (!equipmentIds || equipmentIds.length === 0) return {};

  const rows = await sequelize.query(`
    SELECT v.equipment_id, f.field_key, v.field_value
    FROM dbo.equipment_custom_value v
    JOIN dbo.equipment_custom_field f ON v.field_id = f.field_id
    WHERE v.equipment_id IN (:ids)
  `, { replacements: { ids: equipmentIds }, type: QueryTypes.SELECT });

  const byEquipment = {};
  for (const row of rows) {
    if (!byEquipment[row.equipment_id]) byEquipment[row.equipment_id] = {};
    byEquipment[row.equipment_id][row.field_key] = row.field_value;
  }
  return byEquipment;
}

// MERGE because a device may have no row yet for a field added after it was
// created. The join checks the field is actually attached to its category, so
// a value cannot be stored against a field the category does not use.
//
// Accepts an optional external Sequelize transaction from callers that
// already have one open (partModel.js's part-replacement flow is the live
// example), so the value write commits or rolls back with everything else
// that replacement touched.
async function setValues(equipmentId, values, transaction) {
  const entries = Object.entries(values || {});
  if (entries.length === 0) return;

  for (const [key, value] of entries) {
    await sequelize.query(`
        MERGE dbo.equipment_custom_value AS target
        USING (
            SELECT :equipment_id AS equipment_id, f.field_id
            FROM dbo.equipment_custom_field f
            JOIN dbo.equipment_category_field cf ON cf.field_id = f.field_id
            JOIN dbo.equipment e ON e.category_id = cf.category_id
            WHERE e.equipment_id = :equipment_id AND f.field_key = :field_key
        ) AS source
        ON target.equipment_id = source.equipment_id AND target.field_id = source.field_id
        WHEN MATCHED THEN
            UPDATE SET field_value = :field_value, updated_at = GETDATE()
        WHEN NOT MATCHED THEN
            INSERT (equipment_id, field_id, field_value)
            VALUES (source.equipment_id, source.field_id, :field_value);
      `, {
      replacements: {
        equipment_id: equipmentId,
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
  findByCategory, attachToCategory, detachFromCategory, countValuesInCategory,
  getValues, getValuesForMany, setValues,
};
