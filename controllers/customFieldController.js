const customFieldModel = require('../models/customFieldModel');
const categoryModel = require('../models/categoryModel');

// Custom fields are defined once and shared. An admin creating "Warranty End"
// for one category can attach the same field to another rather than making a
// second one that happens to share a name.

// GET /api/custom-fields - every field, with how many categories use it
async function getAll(req, res, next) {
  try {
    const fields = await customFieldModel.findAll();
    res.json({ count: fields.length, fields });
  } catch (err) {
    next(err);
  }
}

// GET /api/custom-fields/types - what the frontend dropdown should offer
function getTypes(req, res) {
  res.json({
    types: [
      { value: 'text',    label: 'Text',   input: 'text' },
      { value: 'number',  label: 'Number', input: 'number' },
      { value: 'date',    label: 'Date',   input: 'date' },
      { value: 'boolean', label: 'Yes/No', input: 'checkbox' },
    ],
  });
}

// GET /api/custom-fields/category/:categoryId
// Both what this category uses and what else is available to attach.
async function getByCategory(req, res, next) {
  try {
    const category = await categoryModel.findById(req.params.categoryId);
    if (!category) return res.status(404).json({ error: 'Category not found' });

    const [attached, all] = await Promise.all([
      customFieldModel.findByCategory(req.params.categoryId),
      customFieldModel.findAll(),
    ]);

    const attachedIds = new Set(attached.map((f) => f.field_id));

    res.json({
      category_id: category.category_id,
      category_name: category.category_name,
      count: attached.length,
      fields: attached,
      // So the picker can offer reuse instead of prompting a duplicate.
      available_to_add: all.filter((f) => !attachedIds.has(f.field_id)),
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/custom-fields
// Creates the definition. Pass category_id to attach it at the same time.
async function create(req, res, next) {
  const { field_label, field_type, category_id } = req.body;

  if (!field_label) {
    return res.status(400).json({
      error: 'field_label is required',
      example: { field_label: 'Warranty End', field_type: 'date', category_id: 9 },
    });
  }
  if (field_type && !customFieldModel.FIELD_TYPES.includes(field_type)) {
    return res.status(400).json({
      error: `field_type must be one of: ${customFieldModel.FIELD_TYPES.join(', ')}`,
    });
  }

  try {
    const key = customFieldModel.toKey(field_label);
    if (!key) {
      return res.status(400).json({ error: 'field_label must contain at least one letter or number' });
    }

    // A field with this key already exists - attach it rather than refusing,
    // since creating a near-duplicate is the problem this design avoids.
    const existing = await customFieldModel.findByKey(key);
    if (existing) {
      if (!category_id) {
        return res.status(409).json({
          error: `A field called "${existing.field_label}" already exists`,
          hint: 'Attach the existing field to your category instead of creating another.',
          existing,
        });
      }

      const attachedTo = await customFieldModel.findByCategory(category_id);
      if (attachedTo.some((f) => f.field_id === existing.field_id)) {
        return res.status(409).json({
          error: `This category already uses "${existing.field_label}"`,
          existing,
        });
      }

      await customFieldModel.attachToCategory(category_id, existing.field_id, {
        sortOrder: req.body.sort_order,
        isRequired: req.body.is_required,
      });

      return res.status(200).json({
        message: `Existing field "${existing.field_label}" added to this category`,
        reused: true,
        field: existing,
      });
    }

    const field = await customFieldModel.create({
      fieldLabel: field_label,
      fieldType: field_type,
      createdBy: req.user?.username,
    });

    if (category_id) {
      await customFieldModel.attachToCategory(category_id, field.field_id, {
        sortOrder: req.body.sort_order,
        isRequired: req.body.is_required,
      });
    }

    res.status(201).json({
      message: `Field "${field_label}" created`,
      reused: false,
      field,
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/custom-fields/category/:categoryId/attach  { field_id }
async function attach(req, res, next) {
  const { field_id } = req.body;
  if (!field_id) return res.status(400).json({ error: 'field_id is required' });

  try {
    const category = await categoryModel.findById(req.params.categoryId);
    if (!category) return res.status(404).json({ error: 'Category not found' });

    const field = await customFieldModel.findById(field_id);
    if (!field) return res.status(404).json({ error: 'Field not found' });

    await customFieldModel.attachToCategory(req.params.categoryId, field_id, {
      sortOrder: req.body.sort_order,
      isRequired: req.body.is_required,
    });

    res.json({
      message: `"${field.field_label}" added to ${category.category_name}`,
      field,
    });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/custom-fields/category/:categoryId/field/:fieldId
// Removes it from this category only - the definition and other categories'
// values are untouched.
async function detach(req, res, next) {
  try {
    const field = await customFieldModel.findById(req.params.fieldId);
    if (!field) return res.status(404).json({ error: 'Field not found' });

    const valueCount = await customFieldModel.countValuesInCategory(
      req.params.categoryId, req.params.fieldId
    );

    if (valueCount > 0 && req.query.confirm !== 'true') {
      return res.status(409).json({
        error: `${valueCount} item(s) in this category have a value for "${field.field_label}"`,
        value_count: valueCount,
        hint: 'Removing the field hides it from this category. Add ?confirm=true to proceed.',
      });
    }

    const removed = await customFieldModel.detachFromCategory(
      req.params.categoryId, req.params.fieldId
    );
    if (!removed) {
      return res.status(404).json({ error: 'This category does not use that field' });
    }

    res.json({ message: `"${field.field_label}" removed from this category` });
  } catch (err) {
    next(err);
  }
}

// PUT /api/custom-fields/:fieldId - rename or change type, everywhere it is used
async function update(req, res, next) {
  const { field_type } = req.body;

  if (field_type && !customFieldModel.FIELD_TYPES.includes(field_type)) {
    return res.status(400).json({
      error: `field_type must be one of: ${customFieldModel.FIELD_TYPES.join(', ')}`,
    });
  }
  if (req.body.field_key) {
    return res.status(400).json({
      error: 'field_key cannot be changed',
      hint: 'Stored values are linked to it. Create a new field instead.',
    });
  }

  try {
    const field = await customFieldModel.update(req.params.fieldId, {
      fieldLabel: req.body.field_label,
      fieldType: field_type,
    });
    if (!field) return res.status(404).json({ error: 'Field not found' });

    res.json({ message: 'Field updated', field });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/custom-fields/:fieldId - removes the definition everywhere
async function remove(req, res, next) {
  try {
    const field = await customFieldModel.findById(req.params.fieldId);
    if (!field) return res.status(404).json({ error: 'Field not found' });

    const usage = await customFieldModel.countUsage(req.params.fieldId);

    // A shared field may be in use well beyond the category the admin is
    // looking at, so say so before it disappears from all of them.
    if ((usage.category_count > 0 || usage.value_count > 0) && req.query.confirm !== 'true') {
      return res.status(409).json({
        error: `"${field.field_label}" is used by ${usage.category_count} category(ies) and has ${usage.value_count} value(s)`,
        ...usage,
        hint: 'This deletes it everywhere. To remove it from one category only, use DELETE /api/custom-fields/category/{categoryId}/field/{fieldId}. Add ?confirm=true to delete entirely.',
      });
    }

    await customFieldModel.remove(req.params.fieldId);
    res.json({
      message: `Field "${field.field_label}" deleted`,
      categories_affected: usage.category_count,
      values_removed: usage.value_count,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { getAll, getTypes, getByCategory, create, attach, detach, update, remove };