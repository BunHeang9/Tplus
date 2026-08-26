const { sql, poolPromise } = require('../config/db');

// Which part_stock columns each part type's Add/Edit Stock form shows
// (dbo.part_type_stock_column).
//
// Mirrors viewColumnModel.js exactly, one level down: that configures which
// dbo.equipment columns a category's view shows; this configures which
// dbo.part_stock columns a part type's stock form shows. Custom fields are
// the separate, already-built part_type_custom_field system - this is only
// for the built-in columns (model_name, location, quantity, disk_type...),
// selectable per part type instead of every part showing every column.

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
async function validStockFields() {
  const pool = await poolPromise;
  const result = await pool.request().query(`
    SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = 'part_stock' AND TABLE_SCHEMA = 'dbo'
    ORDER BY ORDINAL_POSITION
  `);
  return result.recordset
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
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('field', sql.VarChar, fieldName)
    .query(`
      SELECT 1 AS ok FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME = 'part_stock' AND TABLE_SCHEMA = 'dbo' AND COLUMN_NAME = @field
    `);
  return result.recordset.length > 0;
}

async function findByPartType(partTypeId) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('part_type_id', sql.Int, partTypeId)
    .query(`
      SELECT view_column_id, part_type_id, field_name, header_text, sort_order
      FROM dbo.part_type_stock_column
      WHERE part_type_id = @part_type_id
      ORDER BY sort_order, view_column_id
    `);
  return result.recordset;
}

// One query for every part type at once - GET /api/part-types needs each
// row's columns without a query per part type.
async function findByPartTypes(partTypeIds) {
  if (!partTypeIds || partTypeIds.length === 0) return {};

  const pool = await poolPromise;
  const request = pool.request();
  const params = partTypeIds.map((id, i) => {
    request.input(`t${i}`, sql.Int, id);
    return `@t${i}`;
  });

  const result = await request.query(`
    SELECT part_type_id, field_name, header_text, sort_order
    FROM dbo.part_type_stock_column
    WHERE part_type_id IN (${params.join(',')})
    ORDER BY sort_order
  `);

  const byPartType = {};
  for (const row of result.recordset) {
    if (!byPartType[row.part_type_id]) byPartType[row.part_type_id] = [];
    byPartType[row.part_type_id].push(row);
  }
  return byPartType;
}

// Replaces the whole set for a part type in one transaction - a half-saved
// list would leave the form half-configured if something failed midway.
async function replaceColumns(partTypeId, columns) {
  const pool = await poolPromise;
  const transaction = new sql.Transaction(pool);
  await transaction.begin();

  try {
    await new sql.Request(transaction)
      .input('part_type_id', sql.Int, partTypeId)
      .query('DELETE FROM dbo.part_type_stock_column WHERE part_type_id = @part_type_id');

    for (let i = 0; i < columns.length; i += 1) {
      const col = columns[i];
      await new sql.Request(transaction)
        .input('part_type_id', sql.Int, partTypeId)
        .input('field_name', sql.VarChar, col.field)
        .input('header_text', sql.NVarChar, col.header)
        .input('sort_order', sql.Int, i + 1)
        .query(`
          INSERT INTO dbo.part_type_stock_column
            (part_type_id, field_name, header_text, sort_order)
          VALUES (@part_type_id, @field_name, @header_text, @sort_order)
        `);
    }

    await transaction.commit();
    return await findByPartType(partTypeId);
  } catch (err) {
    try { await transaction.rollback(); } catch { /* already rolled back */ }
    throw err;
  }
}

module.exports = {
  validStockFields, isValidStockField,
  findByPartType, findByPartTypes, replaceColumns,
};
