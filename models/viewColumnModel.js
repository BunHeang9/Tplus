const { sql, poolPromise } = require('../config/db');

// Which columns each category's view shows (dbo.category_view_column).
//
// These used to live in a code file, so adding a category meant editing
// JavaScript and restarting. Holding them in a table lets an admin configure
// a new category from the dashboard instead.

// Columns that are always present and not configurable - a view without an id
// would give the frontend no way to open or edit a row.
const ALWAYS_INCLUDED = ['equipment_id'];

// Columns an admin should never be offered: internal keys, and the text
// duplicates of department/status that exist only for legacy queries.
const HIDDEN_FROM_PICKER = new Set([
  'equipment_id', 'category_id', 'owner_id', 'department_id', 'status_id',
]);

// Friendlier labels for the picker. Anything not listed falls back to the
// column name with underscores replaced.
const SUGGESTED_HEADERS = {
  device_name: "Devicename",
  device_type: "Device Type",
  device_model: "Model",
  computer_name: "Computer Name",
  manufacturer: "Manufacturer",
  serial_no: "Serial Number",
  asset_code: "Asset Code",
  service_tag: "Service Tag",
  product_id: "Product ID",
  mac_address: "MAC Address",
  ip_address: "IP Address",
  os_type: "Type OS",
  os_version: "OS Version",
  platform: "Platform",
  server_type: "Server Type",
  cpu: "CPU",
  ram: "RAM",
  hd: "HD",
  windows_license: "Windows License",
  av_license: "Anti Virus License",
  purchase_date: "Period_date",
  received_date: "Good and receive Date",
  assigned_date: "Assigned Date",
  location: "Location",
  status: "Status",
  remark: "Remark",
};

// Joined columns the frontend can show but which are not on dbo.equipment.
const DERIVED_FIELDS = [
  { field: 'owner_name',       header: 'Owner name',  source: 'employee' },
  { field: 'owner_position',   header: 'Position',    source: 'employee' },
  { field: 'owner_department', header: 'Department',  source: 'employee' },
  { field: 'owner_department_name', header: 'Department', source: 'employee' },
  { field: 'owner_location',   header: 'Owner Location', source: 'employee' },
  { field: 'owner_sex',        header: 'Sex',         source: 'employee' },
  { field: 'category_name',    header: 'Category',    source: 'category' },
  { field: 'status_name',      header: 'Status',      source: 'equipment_status' },
];

// server_usage is the capacity-planning calculation sheet, not part of any
// equipment view - it has its own endpoint (GET /api/server-usage) and is
// deliberately never merged into an equipment/category row, so its columns
// (cpu_core_total, reducing_cpu_core, plan_date...) do not belong here.
// platform/os_type/os_version used to live only in server_usage and were
// listed here as derived fields for that reason; they are now real columns
// on dbo.equipment, so getAvailableFields()'s live schema query picks them
// up on its own - no entry needed.

// Every field an admin can choose from, read live from the schema so a column
// added later shows up without touching this file.
async function getAvailableFields() {
  const pool = await poolPromise;
  const result = await pool.request().query(`
    SELECT COLUMN_NAME, DATA_TYPE
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = 'equipment' AND TABLE_SCHEMA = 'dbo'
    ORDER BY ORDINAL_POSITION
  `);

  const direct = result.recordset
    .filter((c) => !HIDDEN_FROM_PICKER.has(c.COLUMN_NAME))
    .map((c) => ({
      field: c.COLUMN_NAME,
      suggested_header: SUGGESTED_HEADERS[c.COLUMN_NAME]
        || c.COLUMN_NAME.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase()),
      data_type: c.DATA_TYPE,
      source: 'equipment',
    }));

  return { equipment_fields: direct, derived_fields: DERIVED_FIELDS };
}

// Used to reject a field_name that is not a real column - without this a typo
// would produce a view whose every query fails.
async function isValidField(fieldName) {
  if (DERIVED_FIELDS.some((f) => f.field === fieldName)) return true;

  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('field', sql.VarChar, fieldName)
    .query(`
      SELECT 1 AS ok FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME = 'equipment' AND TABLE_SCHEMA = 'dbo' AND COLUMN_NAME = @field
    `);
  return result.recordset.length > 0;
}

async function findByCategory(categoryId) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('category_id', sql.Int, categoryId)
    .query(`
      SELECT view_column_id, category_id, field_name, header_text, sort_order, is_editable
      FROM dbo.category_view_column
      WHERE category_id = @category_id
      ORDER BY sort_order, view_column_id
    `);
  return result.recordset;
}

async function findByViewKey(viewKey) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('view_key', sql.VarChar, viewKey)
    .query(`
      SELECT c.category_id, c.category_name, c.view_key,
             v.field_name, v.header_text, v.sort_order, v.is_editable
      FROM dbo.category c
      LEFT JOIN dbo.category_view_column v ON c.category_id = v.category_id
      WHERE c.view_key = @view_key
      ORDER BY v.sort_order, v.view_column_id
    `);
  return result.recordset;
}

async function listViews() {
  const pool = await poolPromise;
  const result = await pool.request().query(`
    SELECT c.category_id, c.view_key, c.category_name,
           COUNT(v.view_column_id) AS column_count,
           (SELECT COUNT(*) FROM dbo.equipment e WHERE e.category_id = c.category_id) AS item_count
    FROM dbo.category c
    LEFT JOIN dbo.category_view_column v ON c.category_id = v.category_id
    WHERE c.is_active = 1
    GROUP BY c.category_id, c.view_key, c.category_name
    ORDER BY c.category_name
  `);
  return result.recordset;
}

// Replaces the whole set for a category in one transaction. Saving a partial
// list would leave a view half-configured if something failed midway.
async function replaceColumns(categoryId, columns) {
  const pool = await poolPromise;
  const transaction = new sql.Transaction(pool);
  await transaction.begin();

  try {
    await new sql.Request(transaction)
      .input('category_id', sql.Int, categoryId)
      .query('DELETE FROM dbo.category_view_column WHERE category_id = @category_id');

    for (let i = 0; i < columns.length; i += 1) {
      const col = columns[i];
      await new sql.Request(transaction)
        .input('category_id', sql.Int, categoryId)
        .input('field_name', sql.VarChar, col.field)
        .input('header_text', sql.NVarChar, col.header)
        .input('sort_order', sql.Int, i + 1)
        .input('is_editable', sql.Bit, col.editable === false ? 0 : 1)
        .query(`
          INSERT INTO dbo.category_view_column
            (category_id, field_name, header_text, sort_order, is_editable)
          VALUES (@category_id, @field_name, @header_text, @sort_order, @is_editable)
        `);
    }

    await transaction.commit();
    return await findByCategory(categoryId);
  } catch (err) {
    try { await transaction.rollback(); } catch { /* already rolled back */ }
    throw err;
  }
}

async function findCategoryByViewKey(viewKey) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('view_key', sql.VarChar, viewKey)
    .query('SELECT * FROM dbo.category WHERE view_key = @view_key AND is_active = 1');
  return result.recordset[0] || null;
}

module.exports = {
  ALWAYS_INCLUDED,
  getAvailableFields,
  isValidField,
  findByCategory,
  findByViewKey,
  findCategoryByViewKey,
  listViews,
  replaceColumns,
};