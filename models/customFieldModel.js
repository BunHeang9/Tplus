const { DataTypes, fn, col, Op } = require('sequelize');
const sequelize = require('../config/sequelize');

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
EquipmentCustomField.hasMany(EquipmentCategoryField, { foreignKey: 'field_id', as: 'categoryLinks' });

// Equipment.remove() only ever requires this file lazily (inside the
// function body, to dodge a load-time cycle) - never at module top level -
// so this file importing Equipment here is safe in either load order: by
// the time anyone actually calls equipmentModel.remove(), both modules are
// already fully loaded regardless of which one Node reached first.
const { Equipment } = require('./equipmentModel');
EquipmentCustomValue.belongsTo(Equipment, { foreignKey: 'equipment_id', as: 'equipment' });
EquipmentCustomValue.belongsTo(EquipmentCustomField, { foreignKey: 'field_id', as: 'field' });

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
// so an admin can reuse a field rather than recreating it.
async function findAll() {
  return EquipmentCustomField.findAll({
    attributes: [
      'field_id', 'field_key', 'field_label', 'field_type', 'created_at', 'created_by',
      [fn('COUNT', col('categoryLinks.field_id')), 'used_by_categories'],
    ],
    include: [{ model: EquipmentCategoryField, as: 'categoryLinks', attributes: [] }],
    group: [
      'EquipmentCustomField.field_id', 'EquipmentCustomField.field_key', 'EquipmentCustomField.field_label',
      'EquipmentCustomField.field_type', 'EquipmentCustomField.created_at', 'EquipmentCustomField.created_by',
    ],
    order: [['field_label', 'ASC']],
    subQuery: false,
    raw: true,
  });
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
// to know the scale before confirming. Two independent counts merged in JS
// rather than one query - same "single-row lookup, not a list" reasoning as
// borrowModel.findEquipmentForBorrow.
async function countUsage(fieldId) {
  const [category_count, value_count] = await Promise.all([
    EquipmentCategoryField.count({ where: { field_id: fieldId } }),
    EquipmentCustomValue.count({ where: { field_id: fieldId, field_value: { [Op.ne]: null } } }),
  ]);
  return { category_count, value_count };
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
  return EquipmentCustomValue.count({
    where: { field_id: fieldId, field_value: { [Op.ne]: null } },
    include: [{ model: Equipment, as: 'equipment', attributes: [], where: { category_id: categoryId }, required: true }],
  });
}

// --- values ---

// The join key (field_id AND a specific equipment_id) isn't a plain FK a
// static association can express, so this reuses findByCategory() above
// (every field attached to this equipment's category, already ORM) merged
// in JS with this one equipment's own stored values - not a fan-out risk
// since both reads are scoped to exactly one equipment_id.
async function getValues(equipmentId) {
  const equipment = await Equipment.findByPk(equipmentId, { attributes: ['category_id'], raw: true });
  if (!equipment) return [];

  const [fields, values] = await Promise.all([
    findByCategory(equipment.category_id),
    EquipmentCustomValue.findAll({ where: { equipment_id: equipmentId }, raw: true }),
  ]);
  const valueByFieldId = new Map(values.map((v) => [v.field_id, v.field_value]));

  return fields.map((f) => ({
    field_key: f.field_key,
    field_label: f.field_label,
    field_type: f.field_type,
    field_value: valueByFieldId.has(f.field_id) ? valueByFieldId.get(f.field_id) : null,
  }));
}

// One query for a whole page rather than one per row.
async function getValuesForMany(equipmentIds) {
  if (!equipmentIds || equipmentIds.length === 0) return {};

  // The original raw query had no ORDER BY at all, so its row order (and
  // therefore the resulting object's key order) was already undefined -
  // ordering by field_key here doesn't "match" anything, it just makes this
  // version's output deterministic, which the original never was.
  const rows = await EquipmentCustomValue.findAll({
    where: { equipment_id: { [Op.in]: equipmentIds } },
    include: [{ model: EquipmentCustomField, as: 'field', attributes: ['field_key'] }],
    order: [['equipment_id', 'ASC'], [{ model: EquipmentCustomField, as: 'field' }, 'field_key', 'ASC']],
  });

  const byEquipment = {};
  for (const row of rows) {
    const { equipment_id, field, field_value } = row.get({ plain: true });
    if (!byEquipment[equipment_id]) byEquipment[equipment_id] = {};
    byEquipment[equipment_id][field.field_key] = field_value;
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
// The "field exists AND is attached to this equipment's category" gate
// was one atomic MERGE...USING before; here it's an explicit lookup chain
// (field -> attachment -> existing value) ahead of a plain update-or-create,
// same self-contained-multi-step approach already used for assign()/
// unassignById() etc. earlier this session - a category's field attachments
// changing concurrently with a value save is not a realistic race for this
// feature. updated_at is only ever set on the update branch, never the
// create branch (which lets the column's own DB-side default fill it in) -
// matching the original MERGE's INSERT column list, which never included it.
async function setValues(equipmentId, values, transaction) {
  const entries = Object.entries(values || {});
  if (entries.length === 0) return;

  const equipment = await Equipment.findByPk(equipmentId, { attributes: ['category_id'], transaction, raw: true });
  if (!equipment) return;

  for (const [key, value] of entries) {
    const field = await EquipmentCustomField.findOne({
      where: { field_key: key }, attributes: ['field_id'], transaction, raw: true,
    });
    if (!field) continue;

    const attached = await EquipmentCategoryField.findOne({
      where: { category_id: equipment.category_id, field_id: field.field_id }, transaction, raw: true,
    });
    if (!attached) continue;

    const field_value = value === null || value === undefined ? null : String(value);
    const existing = await EquipmentCustomValue.findOne({
      where: { equipment_id: equipmentId, field_id: field.field_id }, transaction,
    });

    if (existing) {
      await existing.update({ field_value, updated_at: fn('GETDATE') }, { transaction });
    } else {
      await EquipmentCustomValue.create({ equipment_id: equipmentId, field_id: field.field_id, field_value }, { transaction });
    }
  }
}

module.exports = {
  FIELD_TYPES, toKey,
  findAll, findById, findByKey, create, update, countUsage, remove,
  findByCategory, attachToCategory, detachFromCategory, countValuesInCategory,
  getValues, getValuesForMany, setValues,
};
