const { sql, poolPromise } = require('../config/db');

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
  const pool = await poolPromise;
  const result = await pool.request().query(`
    SELECT f.field_id, f.field_key, f.field_label, f.field_type,
           f.created_at, f.created_by,
           (SELECT COUNT(*) FROM dbo.part_type_custom_field tf
             WHERE tf.field_id = f.field_id) AS used_by_part_types
    FROM dbo.part_custom_field f
    ORDER BY f.field_label
  `);
  return result.recordset;
}

async function findById(fieldId) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('id', sql.Int, fieldId)
    .query('SELECT * FROM dbo.part_custom_field WHERE field_id = @id');
  return result.recordset[0] || null;
}

async function findByKey(fieldKey) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('field_key', sql.VarChar, fieldKey)
    .query('SELECT * FROM dbo.part_custom_field WHERE field_key = @field_key');
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
      INSERT INTO dbo.part_custom_field (field_key, field_label, field_type, created_by)
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
      UPDATE dbo.part_custom_field
      SET field_label = COALESCE(@field_label, field_label),
          field_type  = COALESCE(@field_type, field_type)
      OUTPUT INSERTED.*
      WHERE field_id = @id
    `);
  return result.recordset[0] || null;
}

// Deleting a shared field affects every part type using it, so the caller
// needs to know the scale before confirming.
async function countUsage(fieldId) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('id', sql.Int, fieldId)
    .query(`
      SELECT
        (SELECT COUNT(*) FROM dbo.part_type_custom_field WHERE field_id = @id) AS part_type_count,
        (SELECT COUNT(*) FROM dbo.part_stock_custom_value
          WHERE field_id = @id AND field_value IS NOT NULL) AS value_count
    `);
  return result.recordset[0];
}

async function remove(fieldId) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('id', sql.Int, fieldId)
    .query('DELETE FROM dbo.part_custom_field OUTPUT DELETED.* WHERE field_id = @id');
  return result.recordset[0] || null;
}

// --- which part types use which fields ---

async function findByPartType(partTypeId) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('part_type_id', sql.Int, partTypeId)
    .query(`
      SELECT f.field_id, f.field_key, f.field_label, f.field_type,
             tf.sort_order, tf.is_required
      FROM dbo.part_type_custom_field tf
      JOIN dbo.part_custom_field f ON tf.field_id = f.field_id
      WHERE tf.part_type_id = @part_type_id
      ORDER BY tf.sort_order, f.field_id
    `);
  return result.recordset;
}

// One query for every part type at once - GET /api/part-types needs each
// row's fields without a query per part type.
async function findByPartTypes(partTypeIds) {
  if (!partTypeIds || partTypeIds.length === 0) return {};

  const pool = await poolPromise;
  const request = pool.request();
  const params = partTypeIds.map((id, i) => {
    request.input(`t${i}`, sql.Int, id);
    return `@t${i}`;
  });

  const result = await request.query(`
    SELECT tf.part_type_id, f.field_id, f.field_key, f.field_label, f.field_type,
           tf.sort_order, tf.is_required
    FROM dbo.part_type_custom_field tf
    JOIN dbo.part_custom_field f ON tf.field_id = f.field_id
    WHERE tf.part_type_id IN (${params.join(',')})
    ORDER BY tf.sort_order, f.field_id
  `);

  const byPartType = {};
  for (const row of result.recordset) {
    if (!byPartType[row.part_type_id]) byPartType[row.part_type_id] = [];
    byPartType[row.part_type_id].push(row);
  }
  return byPartType;
}

// Attaching an existing field to a part type - the reuse case. MERGE so
// calling it twice updates the order rather than failing on the primary key.
async function attachToPartType(partTypeId, fieldId, { sortOrder, isRequired } = {}) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('part_type_id', sql.Int, partTypeId)
    .input('field_id', sql.Int, fieldId)
    .input('sort_order', sql.Int, sortOrder ?? 99)
    .input('is_required', sql.Bit, isRequired ? 1 : 0)
    .query(`
      MERGE dbo.part_type_custom_field AS target
      USING (SELECT @part_type_id AS part_type_id, @field_id AS field_id) AS source
      ON target.part_type_id = source.part_type_id AND target.field_id = source.field_id
      WHEN MATCHED THEN
        UPDATE SET sort_order = @sort_order, is_required = @is_required
      WHEN NOT MATCHED THEN
        INSERT (part_type_id, field_id, sort_order, is_required)
        VALUES (@part_type_id, @field_id, @sort_order, @is_required)
      OUTPUT INSERTED.*;
    `);
  return result.recordset[0];
}

// Removes the field from one part type only. The definition and any values
// on other part types are untouched.
async function detachFromPartType(partTypeId, fieldId) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('part_type_id', sql.Int, partTypeId)
    .input('field_id', sql.Int, fieldId)
    .query(`
      DELETE FROM dbo.part_type_custom_field
      OUTPUT DELETED.*
      WHERE part_type_id = @part_type_id AND field_id = @field_id
    `);
  return result.recordset[0] || null;
}

async function countValuesForPartType(partTypeId, fieldId) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('part_type_id', sql.Int, partTypeId)
    .input('field_id', sql.Int, fieldId)
    .query(`
      SELECT COUNT(*) AS value_count
      FROM dbo.part_stock_custom_value v
      JOIN dbo.part_stock s ON v.stock_id = s.stock_id
      WHERE v.field_id = @field_id AND s.part_type_id = @part_type_id
        AND v.field_value IS NOT NULL
    `);
  return result.recordset[0].value_count;
}

// --- values ---

async function getValues(stockId) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('stock_id', sql.Int, stockId)
    .query(`
      SELECT f.field_key, f.field_label, f.field_type, v.field_value
      FROM dbo.part_stock s
      JOIN dbo.part_type_custom_field tf ON tf.part_type_id = s.part_type_id
      JOIN dbo.part_custom_field f ON tf.field_id = f.field_id
      LEFT JOIN dbo.part_stock_custom_value v
             ON v.field_id = f.field_id AND v.stock_id = s.stock_id
      WHERE s.stock_id = @stock_id
      ORDER BY tf.sort_order, f.field_id
    `);
  return result.recordset;
}

// One query for a whole stock list rather than one per row.
async function getValuesForMany(stockIds) {
  if (!stockIds || stockIds.length === 0) return {};

  const pool = await poolPromise;
  const request = pool.request();
  const params = stockIds.map((id, i) => {
    request.input(`s${i}`, sql.Int, id);
    return `@s${i}`;
  });

  const result = await request.query(`
    SELECT v.stock_id, f.field_key, v.field_value
    FROM dbo.part_stock_custom_value v
    JOIN dbo.part_custom_field f ON v.field_id = f.field_id
    WHERE v.stock_id IN (${params.join(',')})
  `);

  const byStock = {};
  for (const row of result.recordset) {
    if (!byStock[row.stock_id]) byStock[row.stock_id] = {};
    byStock[row.stock_id][row.field_key] = row.field_value;
  }
  return byStock;
}

// MERGE because a stock line may have no row yet for a field added after it
// was created. The join checks the field is actually attached to the line's
// part type, so a value cannot be stored against a field that part type does
// not use.
async function setValues(stockId, values, transaction) {
  const pool = await poolPromise;
  const entries = Object.entries(values || {});
  if (entries.length === 0) return;

  for (const [key, value] of entries) {
    const request = transaction ? new sql.Request(transaction) : pool.request();
    await request
      .input('stock_id', sql.Int, stockId)
      .input('field_key', sql.VarChar, key)
      .input('field_value', sql.NVarChar, value === null || value === undefined ? null : String(value))
      .query(`
        MERGE dbo.part_stock_custom_value AS target
        USING (
            SELECT @stock_id AS stock_id, f.field_id
            FROM dbo.part_custom_field f
            JOIN dbo.part_type_custom_field tf ON tf.field_id = f.field_id
            JOIN dbo.part_stock s ON s.part_type_id = tf.part_type_id
            WHERE s.stock_id = @stock_id AND f.field_key = @field_key
        ) AS source
        ON target.stock_id = source.stock_id AND target.field_id = source.field_id
        WHEN MATCHED THEN
            UPDATE SET field_value = @field_value, updated_at = GETDATE()
        WHEN NOT MATCHED THEN
            INSERT (stock_id, field_id, field_value)
            VALUES (source.stock_id, source.field_id, @field_value);
      `);
  }
}

module.exports = {
  FIELD_TYPES, toKey,
  findAll, findById, findByKey, create, update, countUsage, remove,
  findByPartType, findByPartTypes, attachToPartType, detachFromPartType, countValuesForPartType,
  getValues, getValuesForMany, setValues,
};
