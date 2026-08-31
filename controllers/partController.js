const partModel = require('../models/partModel');
const equipmentModel = require('../models/equipmentModel');
const partStatusModel = require('../models/partStatusModel');
const customFieldModel = require('../models/customFieldModel');
const partCustomFieldModel = require('../models/partCustomFieldModel');
const partStockColumnModel = require('../models/partStockColumnModel');

// equipment_column can point at either a real dbo.equipment column (RAM,
// CPU, HD write straight to the device row) or a custom field key (Mouse,
// Bag, Keyboard live in equipment_custom_value instead) - valid either way,
// so both are checked here rather than only real columns.
async function isValidEquipmentTarget(column) {
  const [columns, fields] = await Promise.all([
    partModel.validEquipmentColumns(),
    customFieldModel.findAll(),
  ]);
  return columns.includes(column) || fields.some((f) => f.field_key === column);
}

// --- part types: what can be replaced ---

// GET /api/part-types
// GET /api/part-types?category_id=5
//
// Narrowed to one category when asked. A camera tripod has no RAM, so
// offering it in the form is a mistake worth preventing rather than
// explaining afterwards.
async function getTypes(req, res, next) {
  try {
    const types = await partModel.findAllTypes(
      req.query.include_inactive === 'true',
      req.query.category_id ? Number(req.query.category_id) : null
    );

    // Each part type's own custom fields (e.g. Battery -> Color, Serial
    // Number) and its chosen built-in stock columns (model_name, location,
    // quantity...), so the Add Stock form knows what inputs to render
    // without a second request per part type.
    const partTypeIds = types.map((t) => t.part_type_id);
    const [fieldsByType, stockColumnsByType] = await Promise.all([
      partCustomFieldModel.findByPartTypes(partTypeIds),
      partStockColumnModel.findByPartTypes(partTypeIds),
    ]);
    const withFields = types.map((t) => ({
      ...t,
      custom_fields: fieldsByType[t.part_type_id] || [],
      stock_columns: stockColumnsByType[t.part_type_id] || [],
    }));

    res.json({
      count: withFields.length,
      category_id: req.query.category_id ? Number(req.query.category_id) : null,
      part_types: withFields,
    });
  } catch (err) {
    next(err);
  }
}

// GET /api/part-types/:id/categories  (admin)
async function getTypeCategories(req, res, next) {
  try {
    const partType = await partModel.findTypeById(req.params.id);
    if (!partType) return res.status(404).json({ error: 'Part type not found' });

    const categories = await partModel.findTypeCategories(req.params.id);
    const linked = categories.filter((c) => c.is_linked);

    res.json({
      part_type_id: Number(req.params.id),
      part_name: partType.part_name,
      // Nothing linked means it applies everywhere - worth saying plainly,
      // since an empty list would otherwise read as "applies nowhere".
      applies_everywhere: linked.length === 0,
      linked_count: linked.length,
      categories,
    });
  } catch (err) {
    next(err);
  }
}

// PUT /api/part-types/:id/categories  (admin)
// { category_ids: [4, 5, 8, 9] } - send the complete list; it replaces.
// An empty array means the part applies everywhere again.
async function setTypeCategories(req, res, next) {
  const { category_ids } = req.body;

  if (!Array.isArray(category_ids)) {
    return res.status(400).json({
      error: 'category_ids must be an array',
      example: { category_ids: [4, 5, 8] },
      note: 'An empty array means the part applies to every category.',
    });
  }

  try {
    const partType = await partModel.findTypeById(req.params.id);
    if (!partType) return res.status(404).json({ error: 'Part type not found' });

    const categories = await partModel.setTypeCategories(req.params.id, category_ids);
    const linked = categories.filter((c) => c.is_linked);

    res.json({
      message: linked.length === 0
        ? `${partType.part_name} now applies to every category`
        : `${partType.part_name} applies to ${linked.length} category(ies)`,
      applies_everywhere: linked.length === 0,
      categories,
    });
  } catch (err) {
    next(err);
  }
}
// GET /api/part-types/columns
// Everything equipment_column can be pointed at, for the admin form - real
// dbo.equipment columns AND custom field keys. Without custom_fields here,
// there is no correct option to pick for a part like Mouse/Bag/Battery that
// syncs into a custom field instead of a real column, and the picker ends up
// offering only unrelated real columns.
async function getAvailableColumns(req, res, next) {
  try {
    const [columns, fields] = await Promise.all([
      partModel.validEquipmentColumns(),
      customFieldModel.findAll(),
    ]);
    res.json({
      note: 'Mapping a part to a column or custom field means replacing it also updates the device. Leave unset to record history only.',
      columns,
      custom_fields: fields.map((f) => ({ field_key: f.field_key, field_label: f.field_label })),
    });
  } catch (err) {
    next(err);
  }
}

// GET /api/part-types/stock-columns
// The built-in part_stock columns (model_name, location, quantity...) a
// part type can choose to show on its Add/Edit Stock form, plus the custom
// fields already available to reuse - separate from equipment_column above,
// which is about syncing into the device, not about the stock form itself.
async function getAvailableStockFields(req, res, next) {
  try {
    const [fields, customFields] = await Promise.all([
      partStockColumnModel.validStockFields(),
      partCustomFieldModel.findAll(),
    ]);
    res.json({
      note: 'Custom fields created here are shared - a field made for one part type can be reused by any other.',
      fields,
      custom_fields: customFields.map((f) => ({ field_key: f.field_key, field_label: f.field_label, field_type: f.field_type })),
    });
  } catch (err) {
    next(err);
  }
}

// GET /api/part-types/:id/stock-columns
// Both halves of the same picker: the built-in part_stock columns chosen for
// this part type, and the custom fields attached to it - the frontend's
// "Stock columns" grid checks boxes across both in one UI.
async function getPartTypeStockColumns(req, res, next) {
  try {
    const partType = await partModel.findTypeById(req.params.id);
    if (!partType) return res.status(404).json({ error: 'Part type not found' });

    const [columns, customFields] = await Promise.all([
      partStockColumnModel.findByPartType(req.params.id),
      partCustomFieldModel.findByPartType(req.params.id),
    ]);
    res.json({
      part_type_id: partType.part_type_id,
      part_name: partType.part_name,
      column_count: columns.length,
      columns,
      custom_field_count: customFields.length,
      custom_fields: customFields,
    });
  } catch (err) {
    next(err);
  }
}

// PUT /api/part-types/:id/stock-columns  (admin)
// Body: { columns: [ { field, header }, ... ] } in display order. Each field
// is either a real part_stock column (model_name, location...) or the key of
// a custom field already created for some part type - the frontend's "+ Add
// field" creates the field first, then this call is what actually attaches
// it to the part type, alongside whichever built-in columns were picked.
async function setPartTypeStockColumns(req, res, next) {
  const { columns } = req.body;

  if (!Array.isArray(columns)) {
    return res.status(400).json({
      error: 'columns must be an array',
      example: { columns: [{ field: 'model_name', header: 'Model Name' }] },
    });
  }

  try {
    const partType = await partModel.findTypeById(req.params.id);
    if (!partType) return res.status(404).json({ error: 'Part type not found' });

    for (const col of columns) {
      if (!col.field || !col.header) {
        return res.status(400).json({
          error: 'Each column needs a field and a header',
          offending: col,
        });
      }
    }

    const seen = new Set();
    const duplicates = [];
    for (const c of columns) {
      if (seen.has(c.field)) duplicates.push(c);
      seen.add(c.field);
    }
    if (duplicates.length > 0) {
      return res.status(400).json({
        error: `A column can only appear once: ${duplicates.map((d) => d.field).join(', ')}`,
      });
    }

    const realColumns = [];
    const fieldColumns = [];
    const invalid = [];
    for (const col of columns) {
      if (await partStockColumnModel.isValidStockField(col.field)) {
        realColumns.push(col);
      } else {
        const field = await partCustomFieldModel.findByKey(col.field);
        if (field) fieldColumns.push({ ...col, field_id: field.field_id });
        else invalid.push(col.field);
      }
    }
    if (invalid.length > 0) {
      return res.status(400).json({
        error: `These are not real part_stock columns or known custom fields: ${invalid.join(', ')}`,
        hint: 'GET /api/part-types/stock-columns lists what can be used.',
      });
    }

    const savedColumns = await partStockColumnModel.replaceColumns(req.params.id, realColumns);

    // Same replace-the-whole-set semantics as the real columns above: attach
    // what is now checked, detach whatever was attached but is not anymore.
    const currentFields = await partCustomFieldModel.findByPartType(req.params.id);
    const keepIds = new Set(fieldColumns.map((f) => f.field_id));
    for (const f of currentFields) {
      if (!keepIds.has(f.field_id)) await partCustomFieldModel.detachFromPartType(req.params.id, f.field_id);
    }
    for (let i = 0; i < fieldColumns.length; i += 1) {
      await partCustomFieldModel.attachToPartType(req.params.id, fieldColumns[i].field_id, { sortOrder: i + 1 });
    }
    const savedFields = await partCustomFieldModel.findByPartType(req.params.id);

    res.json({
      message: `Stock form for ${partType.part_name} updated`,
      column_count: savedColumns.length,
      columns: savedColumns,
      custom_field_count: savedFields.length,
      custom_fields: savedFields,
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/part-types  (admin)
async function createType(req, res, next) {
  const { part_name, equipment_column } = req.body;

  if (!part_name) {
    return res.status(400).json({
      error: 'part_name is required',
      example: { part_name: 'Battery', equipment_column: null, tracks_value: true },
    });
  }

  try {
    const existing = await partModel.findTypeByName(part_name);
    if (existing) {
      return res.status(409).json({ error: `"${part_name}" already exists`, existing });
    }

    // A column/field that does not exist would make every replacement of
    // this part fail at the point of use, long after the mistake was made.
    if (equipment_column && !(await isValidEquipmentTarget(equipment_column))) {
      return res.status(400).json({
        error: `"${equipment_column}" is not a column on the equipment table or a configured custom field`,
        hint: 'GET /api/part-types/columns lists equipment columns; GET /api/custom-fields lists custom field keys. Leave it unset to record history only.',
      });
    }

    const type = await partModel.createType(req.body);
    res.status(201).json({ message: `Part type "${part_name}" created`, part_type: type });
  } catch (err) {
    next(err);
  }
}

// PUT /api/part-types/:id  (admin)
async function updateType(req, res, next) {
  try {
    const existing = await partModel.findTypeById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Part type not found' });

    if (req.body.equipment_column && !(await isValidEquipmentTarget(req.body.equipment_column))) {
      return res.status(400).json({
        error: `"${req.body.equipment_column}" is not a column on the equipment table or a configured custom field`,
      });
    }

    const type = await partModel.updateType(req.params.id, req.body);
    res.json({ message: 'Part type updated', part_type: type });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/part-types/:id  (admin)
async function removeType(req, res, next) {
  try {
    const existing = await partModel.findTypeById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Part type not found' });

    // Deleting would orphan the history of everything replaced with it, so
    // hiding is offered instead.
    const count = await partModel.countTypeUsage(req.params.id);
    if (count > 0) {
      return res.status(409).json({
        error: `Cannot delete "${existing.part_name}": ${count} replacement(s) refer to it`,
        replacement_count: count,
        hint: 'Set is_active to false to hide it from the form while keeping the history.',
      });
    }

    // Deleting would also silently erase whatever is still on the shelf,
    // with no history of it the way a replacement at least leaves behind.
    const stockCount = await partModel.countStockUsage(req.params.id);
    if (stockCount > 0) {
      return res.status(409).json({
        error: `Cannot delete "${existing.part_name}": ${stockCount} still in stock`,
        stock_count: stockCount,
        hint: 'Zero out its stock lines first, or set is_active to false to hide it while keeping the stock.',
      });
    }

    await partModel.removeType(req.params.id);
    res.json({ message: `Part type "${existing.part_name}" deleted` });
  } catch (err) {
    next(err);
  }
}

// --- replacements ---

// GET /api/part-replacements?category=Laptop&q=fongmoua&from=&to=
async function getAll(req, res, next) {
  try {
    const replacements = await partModel.findAll(req.query);
    res.json({ count: replacements.length, replacements });
  } catch (err) {
    next(err);
  }
}

// GET /api/equipment/:id/part-replacements
async function getByEquipment(req, res, next) {
  try {
    const equipment = await equipmentModel.findById(req.params.id);
    if (!equipment) return res.status(404).json({ error: 'Equipment not found' });

    const replacements = await partModel.findByEquipment(req.params.id);
    res.json({
      equipment_id: Number(req.params.id),
      device_name: equipment.device_name || equipment.computer_name,
      count: replacements.length,
      replacements,
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/equipment/:id/part-replacements  (admin)
// { part_type_id, new_value, replacement_date, reason, remark }
async function create(req, res, next) {
  const { part_type_id, action } = req.body;
 
  if (!part_type_id) {
    return res.status(400).json({
      error: 'part_type_id is required',
      hint: 'GET /api/part-types lists what can be replaced.',
    });
  }
  if (req.body.old_part_status) {
    const status = await partStatusModel.findByName(req.body.old_part_status);
    if (!status) {
      const valid = (await partStatusModel.findAll()).map((s) => s.status_name);
      return res.status(400).json({ error: `old_part_status must be one of: ${valid.join(', ')}` });
    }
  }

  try {
    const equipment = await equipmentModel.findById(req.params.id);
    if (!equipment) return res.status(404).json({ error: 'Equipment not found' });
    const applies = await partModel.partAppliesToCategory(
      part_type_id, equipment.category_id
    );
    if (!applies) {
      const partType = await partModel.findTypeById(part_type_id);
      return res.status(400).json({
        error: `${partType?.part_name || 'That part'} does not apply to ${equipment.category_name}`,
        hint: `GET /api/part-types?category_id=${equipment.category_id} lists what does.`,
      });
    }
    const result = await partModel.create(req.params.id, req.body, req.user);
 
    switch (result.error) {
      case 'unknown_part_type':
        return res.status(404).json({ error: 'Part type not found' });
      case 'equipment_not_found':
        return res.status(404).json({ error: 'Equipment not found' });
      case 'bad_action':
        return res.status(400).json({
          error: "action must be 'replace', 'add' or 'remove'",
        });
      case 'not_countable':
        return res.status(400).json({
          error: `${result.part_name} cannot be added to - there is no total to add to`,
          hint: "Use action 'replace' instead. Only RAM and storage accumulate.",
        });
      case 'cannot_sum':
        return res.status(400).json({
          error: `Cannot add ${result.adding} to "${result.current}" - the current value is not a number`,
          current: result.current,
          hint: "Fix the device's value first, or use action 'replace' with the total.",
        });
      case 'stock_empty':
        return res.status(409).json({
          error: 'That stock line is empty',
          hint: 'GET /api/part-stock/available shows what can be fitted.',
        });
      case 'stock_required':
        return res.status(400).json({
          error: `${result.part_name} must come from stock`,
          hint: 'Pick a line from GET /api/part-stock/available and send its stock_id as from_stock_id. If the part was just bought, add it to stock first with POST /api/part-stock.',
        });
      default:
        break;
    }
 
    const verb = { replace: 'replaced', add: 'added', remove: 'removed' }[result.action];
 
    res.status(201).json({
      message: `${result.part_name} ${verb}`,
      action: result.action,
      old_value: result.old_value,
      new_value: result.new_value,
      // What the device now reads. On 'add' this is the sum, which is not
      // obvious from the values sent, so it is returned explicitly.
      resulting_value: result.resulting_value,
      equipment_updated: result.equipment_updated,
      // What went to stock, and what came out of it.
      stock_added: result.stock_added,
      stock_taken: result.stock_taken,
      replacement: result.replacement,
    });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/equipment/:id/part-replacements/:replacementId  (admin)
// Undoes a mistaken entry - puts the device's field and stock back to how
// they were before this replacement, then removes the history row.
async function removeReplacement(req, res, next) {
  try {
    const result = await partModel.removeReplacement(
      req.params.replacementId,
      req.params.id,
    );

    if (result.error === 'not_found') {
      return res.status(404).json({ error: 'Replacement record not found' });
    }
    if (result.error === 'cannot_undo_add') {
      return res.status(409).json({
        error: "Cannot undo an 'add' automatically - the value before the addition was not recorded, so there is nothing reliable to restore the device to",
        hint: 'Correct the device directly with PUT /api/equipment/:id if the value is wrong.',
      });
    }

    res.json({ message: 'Replacement undone', removed: result.removed });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getTypes, getAvailableColumns, createType, updateType, removeType,
  getTypeCategories, setTypeCategories,
  getAvailableStockFields, getPartTypeStockColumns, setPartTypeStockColumns,
  getAll, getByEquipment, create, removeReplacement,
};