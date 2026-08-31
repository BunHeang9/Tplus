const { DataTypes } = require('sequelize');
const sequelize = require('../config/sequelize');
const { QueryTypes } = require('sequelize');
const { Category } = require('./categoryModel');

// Which columns each category's view shows (dbo.category_view_column).
//
// These used to live in a code file, so adding a category meant editing
// JavaScript and restarting. Holding them in a table lets an admin configure
// a new category from the dashboard instead.

const CategoryViewColumn = sequelize.define('CategoryViewColumn', {
  view_column_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  category_id: { type: DataTypes.INTEGER, allowNull: false },
  field_name: { type: DataTypes.STRING(100), allowNull: false },
  header_text: { type: DataTypes.STRING(100), allowNull: false },
  sort_order: { type: DataTypes.INTEGER, allowNull: false },
  is_editable: { type: DataTypes.BOOLEAN, allowNull: false },
  // Has its own DB-side default (legacy DATETIME) - let the DB fill it in,
  // same reasoning as every other table with this pattern in this migration.
  created_at: { type: DataTypes.DATE, allowNull: true },
}, {
  tableName: 'category_view_column',
  schema: 'dbo',
  timestamps: false,
});

Category.hasMany(CategoryViewColumn, { foreignKey: 'category_id', as: 'viewColumns' });

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
// (cpu_core_total, cpu_usage_pct, due_date...) do not belong here.
// platform/os_type/os_version used to live only in server_usage and were
// listed here as derived fields for that reason; they are now real columns
// on dbo.equipment, so getAvailableFields()'s live schema query picks them
// up on its own - no entry needed.

// Every field an admin can choose from, read live from the schema so a column
// added later shows up without touching this file. INFORMATION_SCHEMA
// introspection - raw query, not something an ORM model represents.
async function getAvailableFields() {
  const cols = await sequelize.query(`
    SELECT COLUMN_NAME, DATA_TYPE
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = 'equipment' AND TABLE_SCHEMA = 'dbo'
    ORDER BY ORDINAL_POSITION
  `, { type: QueryTypes.SELECT });

  const direct = cols
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

  const [row] = await sequelize.query(`
    SELECT 1 AS ok FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = 'equipment' AND TABLE_SCHEMA = 'dbo' AND COLUMN_NAME = :field
  `, { replacements: { field: fieldName }, type: QueryTypes.SELECT });
  return !!row;
}

async function findByCategory(categoryId) {
  return CategoryViewColumn.findAll({
    attributes: ['view_column_id', 'category_id', 'field_name', 'header_text', 'sort_order', 'is_editable'],
    where: { category_id: categoryId },
    order: [['sort_order', 'ASC'], ['view_column_id', 'ASC']],
    raw: true,
  });
}

// A LEFT JOIN from category to its columns - a category with none
// configured still needs to come back (with an empty column set), not be
// silently dropped, so the include below isn't `required`. Flattened back
// into the same one-row-per-column (or one all-null row) shape the raw
// LEFT JOIN gave, since Category.hasMany(...) naturally nests the columns
// under a single category row instead.
async function findByViewKey(viewKey) {
  const cat = await Category.findOne({
    where: { view_key: viewKey },
    include: [{ model: CategoryViewColumn, as: 'viewColumns' }],
  });
  if (!cat) return [];

  const { category_id, category_name, view_key: vk, viewColumns } = cat.get({ plain: true });
  const base = { category_id, category_name, view_key: vk };

  if (!viewColumns || viewColumns.length === 0) {
    return [{ ...base, field_name: null, header_text: null, sort_order: null, is_editable: null }];
  }

  return viewColumns
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order || a.view_column_id - b.view_column_id)
    .map((v) => ({
      ...base,
      field_name: v.field_name,
      header_text: v.header_text,
      sort_order: v.sort_order,
      is_editable: v.is_editable,
    }));
}

async function listViews() {
  return sequelize.query(`
    SELECT c.category_id, c.view_key, c.category_name,
           COUNT(v.view_column_id) AS column_count,
           (SELECT COUNT(*) FROM dbo.equipment e WHERE e.category_id = c.category_id) AS item_count
    FROM dbo.category c
    LEFT JOIN dbo.category_view_column v ON c.category_id = v.category_id
    WHERE c.is_active = 1
    GROUP BY c.category_id, c.view_key, c.category_name
    ORDER BY c.category_name
  `, { type: QueryTypes.SELECT });
}

// Replaces the whole set for a category in one transaction. Saving a partial
// list would leave a view half-configured if something failed midway.
async function replaceColumns(categoryId, columns) {
  await sequelize.transaction(async (transaction) => {
    await CategoryViewColumn.destroy({ where: { category_id: categoryId }, transaction });

    if (columns.length > 0) {
      await CategoryViewColumn.bulkCreate(
        columns.map((col, i) => ({
          category_id: categoryId,
          field_name: col.field,
          header_text: col.header,
          sort_order: i + 1,
          is_editable: col.editable !== false,
        })),
        { transaction },
      );
    }
  });
  return findByCategory(categoryId);
}

async function findCategoryByViewKey(viewKey) {
  return Category.findOne({ where: { view_key: viewKey, is_active: true }, raw: true });
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
