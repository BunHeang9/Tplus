const { sql, poolPromise } = require('../config/db');

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
  const pool = await poolPromise;
  const result = await pool.request().query(`
    SELECT f.field_id, f.field_key, f.field_label, f.field_type,
           f.created_at, f.created_by,
           (SELECT COUNT(*) FROM dbo.equipment_category_field cf
             WHERE cf.field_id = f.field_id) AS used_by_categories
    FROM dbo.equipment_custom_field f
    ORDER BY f.field_label
  `);
  return result.recordset;
}

async function findById(fieldId) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('id', sql.Int, fieldId)
    .query('SELECT * FROM dbo.equipment_custom_field WHERE field_id = @id');
  return result.recordset[0] || null;
}

async function findByKey(fieldKey) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('field_key', sql.VarChar, fieldKey)
    .query('SELECT * FROM dbo.equipment_custom_field WHERE field_key = @field_key');
  return result.recordset[0] || null;
}

async function create({ fieldLabel, fieldType, createdBy }) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('field_key', sql.VarChar, toKey(fieldLabel))
    .input('field_label', sql.NVarChar, fieldLabel)
    .input('field_type', sql.VarChar, fieldType || 'text')
    .input('created_by', sql.NVarChar, createdBy || null)
    .query(`
      INSERT INTO dbo.equipment_custom_field (field_key, field_label, field_type, created_by)
      OUTPUT INSERTED.*
      VALUES (@field_key, @field_label, @field_type, @created_by)
    `);
  return result.recordset[0];
}

// The key is deliberately not updatable - every stored value is linked to it.
async function update(fieldId, { fieldLabel, fieldType }) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('id', sql.Int, fieldId)
    .input('field_label', sql.NVarChar, fieldLabel)
    .input('field_type', sql.VarChar, fieldType)
    .query(`
      UPDATE dbo.equipment_custom_field
      SET field_label = COALESCE(@field_label, field_label),
          field_type  = COALESCE(@field_type, field_type)
      OUTPUT INSERTED.*
      WHERE field_id = @id
    `);
  return result.recordset[0] || null;
}

// Deleting a shared field affects every category using it, so the caller needs
// to know the scale before confirming.
async function countUsage(fieldId) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('id', sql.Int, fieldId)
    .query(`
      SELECT
        (SELECT COUNT(*) FROM dbo.equipment_category_field WHERE field_id = @id) AS category_count,
        (SELECT COUNT(*) FROM dbo.equipment_custom_value
          WHERE field_id = @id AND field_value IS NOT NULL) AS value_count
    `);
  return result.recordset[0];
}

async function remove(fieldId) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('id', sql.Int, fieldId)
    .query('DELETE FROM dbo.equipment_custom_field OUTPUT DELETED.* WHERE field_id = @id');
  return result.recordset[0] || null;
}

// --- which categories use which fields ---

async function findByCategory(categoryId) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('category_id', sql.Int, categoryId)
    .query(`
      SELECT f.field_id, f.field_key, f.field_label, f.field_type,
             cf.sort_order, cf.is_required
      FROM dbo.equipment_category_field cf
      JOIN dbo.equipment_custom_field f ON cf.field_id = f.field_id
      WHERE cf.category_id = @category_id
      ORDER BY cf.sort_order, f.field_id
    `);
  return result.recordset;
}

// Attaching an existing field to a category - the reuse case. MERGE so calling
// it twice updates the order rather than failing on the primary key.
async function attachToCategory(categoryId, fieldId, { sortOrder, isRequired } = {}) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('category_id', sql.Int, categoryId)
    .input('field_id', sql.Int, fieldId)
    .input('sort_order', sql.Int, sortOrder ?? 99)
    .input('is_required', sql.Bit, isRequired ? 1 : 0)
    .query(`
      MERGE dbo.equipment_category_field AS target
      USING (SELECT @category_id AS category_id, @field_id AS field_id) AS source
      ON target.category_id = source.category_id AND target.field_id = source.field_id
      WHEN MATCHED THEN
        UPDATE SET sort_order = @sort_order, is_required = @is_required
      WHEN NOT MATCHED THEN
        INSERT (category_id, field_id, sort_order, is_required)
        VALUES (@category_id, @field_id, @sort_order, @is_required)
      OUTPUT INSERTED.*;
    `);
  return result.recordset[0];
}

// Removes the field from one category only. The definition and any values on
// other categories are untouched.
async function detachFromCategory(categoryId, fieldId) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('category_id', sql.Int, categoryId)
    .input('field_id', sql.Int, fieldId)
    .query(`
      DELETE FROM dbo.equipment_category_field
      OUTPUT DELETED.*
      WHERE category_id = @category_id AND field_id = @field_id
    `);
  return result.recordset[0] || null;
}

async function countValuesInCategory(categoryId, fieldId) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('category_id', sql.Int, categoryId)
    .input('field_id', sql.Int, fieldId)
    .query(`
      SELECT COUNT(*) AS value_count
      FROM dbo.equipment_custom_value v
      JOIN dbo.equipment e ON v.equipment_id = e.equipment_id
      WHERE v.field_id = @field_id AND e.category_id = @category_id
        AND v.field_value IS NOT NULL
    `);
  return result.recordset[0].value_count;
}

// --- values ---

async function getValues(equipmentId) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('equipment_id', sql.Int, equipmentId)
    .query(`
      SELECT f.field_key, f.field_label, f.field_type, v.field_value
      FROM dbo.equipment e
      JOIN dbo.equipment_category_field cf ON cf.category_id = e.category_id
      JOIN dbo.equipment_custom_field f ON cf.field_id = f.field_id
      LEFT JOIN dbo.equipment_custom_value v
             ON v.field_id = f.field_id AND v.equipment_id = e.equipment_id
      WHERE e.equipment_id = @equipment_id
      ORDER BY cf.sort_order, f.field_id
    `);
  return result.recordset;
}

// One query for a whole page rather than one per row.
async function getValuesForMany(equipmentIds) {
  if (!equipmentIds || equipmentIds.length === 0) return {};

  const pool = await poolPromise;
  const request = pool.request();
  const params = equipmentIds.map((id, i) => {
    request.input(`e${i}`, sql.Int, id);
    return `@e${i}`;
  });

  const result = await request.query(`
    SELECT v.equipment_id, f.field_key, v.field_value
    FROM dbo.equipment_custom_value v
    JOIN dbo.equipment_custom_field f ON v.field_id = f.field_id
    WHERE v.equipment_id IN (${params.join(',')})
  `);

  const byEquipment = {};
  for (const row of result.recordset) {
    if (!byEquipment[row.equipment_id]) byEquipment[row.equipment_id] = {};
    byEquipment[row.equipment_id][row.field_key] = row.field_value;
  }
  return byEquipment;
}

// MERGE because a device may have no row yet for a field added after it was
// created. The join checks the field is actually attached to its category, so
// a value cannot be stored against a field the category does not use.
async function setValues(equipmentId, values, transaction) {
  const pool = await poolPromise;
  const entries = Object.entries(values || {});
  if (entries.length === 0) return;

  for (const [key, value] of entries) {
    const request = transaction ? new sql.Request(transaction) : pool.request();
    await request
      .input('equipment_id', sql.Int, equipmentId)
      .input('field_key', sql.VarChar, key)
      .input('field_value', sql.NVarChar, value === null || value === undefined ? null : String(value))
      .query(`
        MERGE dbo.equipment_custom_value AS target
        USING (
            SELECT @equipment_id AS equipment_id, f.field_id
            FROM dbo.equipment_custom_field f
            JOIN dbo.equipment_category_field cf ON cf.field_id = f.field_id
            JOIN dbo.equipment e ON e.category_id = cf.category_id
            WHERE e.equipment_id = @equipment_id AND f.field_key = @field_key
        ) AS source
        ON target.equipment_id = source.equipment_id AND target.field_id = source.field_id
        WHEN MATCHED THEN
            UPDATE SET field_value = @field_value, updated_at = GETDATE()
        WHEN NOT MATCHED THEN
            INSERT (equipment_id, field_id, field_value)
            VALUES (source.equipment_id, source.field_id, @field_value);
      `);
  }
}

module.exports = {
  FIELD_TYPES, toKey,
  findAll, findById, findByKey, create, update, countUsage, remove,
  findByCategory, attachToCategory, detachFromCategory, countValuesInCategory,
  getValues, getValuesForMany, setValues,
};