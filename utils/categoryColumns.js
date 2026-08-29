const viewColumnModel = require('../models/viewColumnModel');
const customFieldModel = require('../models/customFieldModel');

// Shared helper so the assign and replacement pages show the same columns as
// the equipment page.
//
// Picking a laptop to replace without seeing its RAM, or choosing one from
// stock without its CPU, makes the decision guesswork. Each category already
// has a configured layout in dbo.category_view_column - this reuses it rather
// than every page inventing its own.

// Always present regardless of what an admin configured. equipment_id because
// nothing can be selected without it; owner because these pages are about who
// holds what, even when the answer is nobody.
const ALWAYS = [
  { field: 'equipment_id', header: 'No.' },
  { field: 'owner_name',   header: 'Owner' },
];

// Returns the header list plus a function that reduces a full equipment row to
// just those fields.
async function buildFor(categoryName) {
  if (!categoryName) return null;

  const category = await viewColumnModel.findCategoryByViewKey(
    String(categoryName).toLowerCase().replace(/ /g, '-')
  );
  if (!category) return null;

  const [columns, customFields] = await Promise.all([
    viewColumnModel.findByCategory(category.category_id),
    customFieldModel.findByCategory(category.category_id),
  ]);

  // A category with nothing configured falls back to the caller's own layout
  // rather than returning an empty table.
  if (columns.length === 0 && customFields.length === 0) return null;

  const configured = columns.map((c) => ({ field: c.field_name, header: c.header_text }));
  const custom = customFields.map((f) => ({
    field: f.field_key, header: f.field_label, custom: true,
  }));

  // ALWAYS first, then whatever the admin configured - minus anything already
  // in ALWAYS, so owner does not appear twice on categories that include it.
  const alwaysFields = new Set(ALWAYS.map((c) => c.field));
  const headers = [
    ...ALWAYS,
    ...configured.filter((c) => !alwaysFields.has(c.field)),
    ...custom,
  ];

  return {
    category_id: category.category_id,
    category_name: category.category_name,
    headers,
    customFields,
  };
}

// Reduces a row to the configured fields, merging in any custom values.
function project(row, headers, customValues = {}) {
  if (!row) return null;
  const out = {};
  for (const h of headers) {
    out[h.field] = h.custom ? (customValues[h.field] ?? null) : (row[h.field] ?? null);
  }
  return out;
}

// Custom values for a whole page in one query rather than one per row.
async function customValuesFor(view, equipmentIds) {
  if (!view || view.customFields.length === 0 || equipmentIds.length === 0) return {};
  return customFieldModel.getValuesForMany(equipmentIds);
}

module.exports = { ALWAYS, buildFor, project, customValuesFor };