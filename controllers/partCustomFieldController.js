const partCustomFieldModel = require('../models/partCustomFieldModel');
const partModel = require('../models/partModel');

// Custom fields for part types are defined once and shared. An admin
// creating "Serial Number" for one part type can attach the same field to
// another rather than making a second one that happens to share a name.

// GET /api/part-custom-fields - every field, with how many part types use it
async function getAll(req, res, next) {
  try {
    const fields = await partCustomFieldModel.findAll();
    res.json({ count: fields.length, fields });
  } catch (err) {
    next(err);
  }
}

// GET /api/part-custom-fields/types - what the frontend dropdown should offer
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

// GET /api/part-custom-fields/part-type/:partTypeId
// Both what this part type uses and what else is available to attach.
async function getByPartType(req, res, next) {
  try {
    const partType = await partModel.findTypeById(req.params.partTypeId);
    if (!partType) return res.status(404).json({ error: 'Part type not found' });

    const [attached, all] = await Promise.all([
      partCustomFieldModel.findByPartType(req.params.partTypeId),
      partCustomFieldModel.findAll(),
    ]);

    const attachedIds = new Set(attached.map((f) => f.field_id));

    res.json({
      part_type_id: partType.part_type_id,
      part_name: partType.part_name,
      count: attached.length,
      fields: attached,
      // So the picker can offer reuse instead of prompting a duplicate.
      available_to_add: all.filter((f) => !attachedIds.has(f.field_id)),
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/part-custom-fields
// Creates the definition. Pass part_type_id to attach it at the same time.
async function create(req, res, next) {
  const { field_label, field_type, part_type_id } = req.body;

  if (!field_label) {
    return res.status(400).json({
      error: 'field_label is required',
      example: { field_label: 'Color', field_type: 'text', part_type_id: 14 },
    });
  }
  if (field_type && !partCustomFieldModel.FIELD_TYPES.includes(field_type)) {
    return res.status(400).json({
      error: `field_type must be one of: ${partCustomFieldModel.FIELD_TYPES.join(', ')}`,
    });
  }

  try {
    const key = partCustomFieldModel.toKey(field_label);
    if (!key) {
      return res.status(400).json({ error: 'field_label must contain at least one letter or number' });
    }

    // A field with this key already exists - attach it rather than refusing,
    // since creating a near-duplicate is the problem this design avoids.
    const existing = await partCustomFieldModel.findByKey(key);
    if (existing) {
      if (!part_type_id) {
        return res.status(409).json({
          error: `A field called "${existing.field_label}" already exists`,
          hint: 'Attach the existing field to your part type instead of creating another.',
          existing,
        });
      }

      const attachedTo = await partCustomFieldModel.findByPartType(part_type_id);
      if (attachedTo.some((f) => f.field_id === existing.field_id)) {
        return res.status(409).json({
          error: `This part type already uses "${existing.field_label}"`,
          existing,
        });
      }

      await partCustomFieldModel.attachToPartType(part_type_id, existing.field_id, {
        sortOrder: req.body.sort_order,
        isRequired: req.body.is_required,
      });

      return res.status(200).json({
        message: `Existing field "${existing.field_label}" added to this part type`,
        reused: true,
        field: existing,
      });
    }

    const field = await partCustomFieldModel.create({
      fieldLabel: field_label,
      fieldType: field_type,
      createdBy: req.user?.username,
    });

    if (part_type_id) {
      await partCustomFieldModel.attachToPartType(part_type_id, field.field_id, {
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

// POST /api/part-custom-fields/part-type/:partTypeId/attach  { field_id }
async function attach(req, res, next) {
  const { field_id } = req.body;
  if (!field_id) return res.status(400).json({ error: 'field_id is required' });

  try {
    const partType = await partModel.findTypeById(req.params.partTypeId);
    if (!partType) return res.status(404).json({ error: 'Part type not found' });

    const field = await partCustomFieldModel.findById(field_id);
    if (!field) return res.status(404).json({ error: 'Field not found' });

    await partCustomFieldModel.attachToPartType(req.params.partTypeId, field_id, {
      sortOrder: req.body.sort_order,
      isRequired: req.body.is_required,
    });

    res.json({
      message: `"${field.field_label}" added to ${partType.part_name}`,
      field,
    });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/part-custom-fields/part-type/:partTypeId/field/:fieldId
// Removes it from this part type only - the definition and other part types'
// values are untouched.
async function detach(req, res, next) {
  try {
    const field = await partCustomFieldModel.findById(req.params.fieldId);
    if (!field) return res.status(404).json({ error: 'Field not found' });

    const valueCount = await partCustomFieldModel.countValuesForPartType(
      req.params.partTypeId, req.params.fieldId
    );

    if (valueCount > 0 && req.query.confirm !== 'true') {
      return res.status(409).json({
        error: `${valueCount} stock line(s) of this part type have a value for "${field.field_label}"`,
        value_count: valueCount,
        hint: 'Removing the field hides it from this part type. Add ?confirm=true to proceed.',
      });
    }

    const removed = await partCustomFieldModel.detachFromPartType(
      req.params.partTypeId, req.params.fieldId
    );
    if (!removed) {
      return res.status(404).json({ error: 'This part type does not use that field' });
    }

    res.json({ message: `"${field.field_label}" removed from this part type` });
  } catch (err) {
    next(err);
  }
}

// PUT /api/part-custom-fields/:fieldId - rename or change type, everywhere it is used
async function update(req, res, next) {
  const { field_type } = req.body;

  if (field_type && !partCustomFieldModel.FIELD_TYPES.includes(field_type)) {
    return res.status(400).json({
      error: `field_type must be one of: ${partCustomFieldModel.FIELD_TYPES.join(', ')}`,
    });
  }
  if (req.body.field_key) {
    return res.status(400).json({
      error: 'field_key cannot be changed',
      hint: 'Stored values are linked to it. Create a new field instead.',
    });
  }

  try {
    const field = await partCustomFieldModel.update(req.params.fieldId, {
      fieldLabel: req.body.field_label,
      fieldType: field_type,
    });
    if (!field) return res.status(404).json({ error: 'Field not found' });

    res.json({ message: 'Field updated', field });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/part-custom-fields/:fieldId - removes the definition everywhere
async function remove(req, res, next) {
  try {
    const field = await partCustomFieldModel.findById(req.params.fieldId);
    if (!field) return res.status(404).json({ error: 'Field not found' });

    const usage = await partCustomFieldModel.countUsage(req.params.fieldId);

    // A shared field may be in use well beyond the part type the admin is
    // looking at, so say so before it disappears from all of them.
    if ((usage.part_type_count > 0 || usage.value_count > 0) && req.query.confirm !== 'true') {
      return res.status(409).json({
        error: `"${field.field_label}" is used by ${usage.part_type_count} part type(s) and has ${usage.value_count} value(s)`,
        ...usage,
        hint: 'This deletes it everywhere. To remove it from one part type only, use DELETE /api/part-custom-fields/part-type/{partTypeId}/field/{fieldId}. Add ?confirm=true to delete entirely.',
      });
    }

    await partCustomFieldModel.remove(req.params.fieldId);
    res.json({
      message: `Field "${field.field_label}" deleted`,
      part_types_affected: usage.part_type_count,
      values_removed: usage.value_count,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { getAll, getTypes, getByPartType, create, attach, detach, update, remove };
