const viewColumnModel = require('../models/viewColumnModel');
const categoryModel = require('../models/categoryModel');
const customFieldModel = require("../models/customFieldModel");
// Admin-facing configuration of what each category's view shows.
// The picker is driven by the real schema, so a column added to dbo.equipment
// later appears here without any code change.

// GET /api/view-columns/available-fields
async function getAvailableFields(req, res, next) {
  try {
    res.json(await viewColumnModel.getAvailableFields());
  } catch (err) {
    next(err);
  }
}

// GET /api/view-columns - every category with how many columns it has
async function listViews(req, res, next) {
  try {
    const views = await viewColumnModel.listViews();
    res.json({
      count: views.length,
      // Flagged so the dashboard can prompt: a category with no columns has no
      // usable view yet, which is the state a newly created one starts in.
      unconfigured: views
        .filter((v) => v.column_count === 0)
        .map((v) => v.category_name),
      views,
    });
  } catch (err) {
    next(err);
  }
}

// GET /api/view-columns/:categoryId
async function getByCategory(req, res, next) {
  try {
    const category = await categoryModel.findById(req.params.categoryId);
    if (!category) return res.status(404).json({ error: "Category not found" });

    const columns = await viewColumnModel.findByCategory(req.params.categoryId);
    res.json({
      category_id: category.category_id,
      category_name: category.category_name,
      view_key: category.view_key,
      column_count: columns.length,
      columns,
    });
  } catch (err) {
    next(err);
  }
}

// PUT /api/view-columns/:categoryId
// Body: { columns: [ { field, header, editable }, ... ] } in display order
async function setColumns(req, res, next) {
  const { columns } = req.body;

  if (!Array.isArray(columns)) {
    return res.status(400).json({
      error: "columns must be an array",
      example: {
        columns: [
          { field: "device_name", header: "Devicename", editable: true },
        ],
      },
    });
  }

  // 1. Instantly filter out any 'hd' fields from processing
  const cleanColumns = columns.filter(
    (c) => c.field && c.field.toLowerCase() !== "hd",
  );

  // 2. Validate against the length of cleanColumns
  if (cleanColumns.length === 0) {
    return res.status(400).json({
      error: "A view needs at least one column",
      hint: "Use GET /api/view-columns/available-fields to see what can be chosen.",
    });
  }

  try {
    const category = await categoryModel.findById(req.params.categoryId);
    if (!category) return res.status(404).json({ error: "Category not found" });

    // Fetch custom fields to prevent validating them out
    const customFields = await customFieldModel.findByCategory(
      req.params.categoryId,
    );
    const validCustomFieldKeys = customFields.map((f) => f.field_key);

    // 3. Loop through cleanColumns instead of columns
    const invalid = [];
    for (const col of cleanColumns) {
      if (!col.field || !col.header) {
        return res.status(400).json({
          error: "Each column needs a field and a header",
          offending: col,
        });
      }

      // Check both standard schema fields and custom fields
      const isStandardField = await viewColumnModel.isValidField(col.field);
      const isCustomField = validCustomFieldKeys.includes(col.field);

      if (!isStandardField && !isCustomField) {
        invalid.push(col.field);
      }
    }

    if (invalid.length > 0) {
      return res.status(400).json({
        error: `These are not real columns: ${invalid.join(", ")}`,
        hint: "GET /api/view-columns/available-fields lists what can be used.",
      });
    }

    // 4. Run duplicate tracking on cleanColumns
    const seen = new Set();
    const duplicates = cleanColumns.filter((c) => {
      if (seen.has(c.field)) return true;
      seen.add(c.field);
      return false;
    });
    if (duplicates.length > 0) {
      return res.status(400).json({
        error: `A column can only appear once: ${duplicates.map((d) => d.field).join(", ")}`,
      });
    }

    // 5. Explicitly pass cleanColumns to the database model to strip out 'hd'
    const saved = await viewColumnModel.replaceColumns(
      req.params.categoryId,
      cleanColumns,
    );

    res.json({
      message: `View for ${category.category_name} updated`,
      category_name: category.category_name,
      view_key: category.view_key,
      column_count: saved.length,
      columns: saved,
    });
  } catch (err) {
    next(err);
  }
}


module.exports = { getAvailableFields, listViews, getByCategory, setColumns };