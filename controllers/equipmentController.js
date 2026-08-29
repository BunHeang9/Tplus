const equipmentModel = require('../models/equipmentModel');
const categoryModel = require('../models/categoryModel');
const departmentModel = require('../models/departmentModel');
const customFieldModel = require('../models/customFieldModel');
const { sql, poolPromise } = require('../config/db');

// Custom fields (Bag Model, Mouse Model, Keyboard Model, and anything else an
// admin has configured per category) live in equipment_custom_value, not on
// dbo.equipment itself - GET /api/employees/:id/full already merges these in,
// this brings the plain equipment list up to the same level rather than
// leaving it as a second, thinner view of the same data.
//
// Not hardcoded to any particular field: whatever is configured for a row's
// category comes back, so a newly added custom field (or a brand new
// category) works without another code change here.
async function attachCustomFields(rows) {
  const equipmentIds = rows.map((r) => r.equipment_id);
  const categoryIds = [...new Set(rows.map((r) => r.category_id).filter(Boolean))];
  if (categoryIds.length === 0) return rows;

  const fieldsByCategory = {};
  for (const categoryId of categoryIds) {
    fieldsByCategory[categoryId] = await customFieldModel.findByCategory(categoryId);
  }
  const valuesByEquipment = await customFieldModel.getValuesForMany(equipmentIds);

  for (const row of rows) {
    const fields = fieldsByCategory[row.category_id] || [];
    const values = valuesByEquipment[row.equipment_id] || {};
    for (const f of fields) row[f.field_key] = values[f.field_key] ?? null;
  }
  return rows;
}

async function getAll(req, res, next) {
  try {
    const equipment = await equipmentModel.findAll(req.query);
    res.json(await attachCustomFields(equipment));
  } catch (err) {
    next(err);
  }
}

async function getCategories(req, res, next) {
  try {
    const summary = await equipmentModel.getCategorySummary();
    res.json(summary);
  } catch (err) {
    next(err);
  }
}

//unssign
async function unassign(req, res) {
  const { equipment_id, equipment_ids, owner_id, status } = req.body;
    const selectors = [
      Boolean(equipment_id),
      Array.isArray(equipment_ids) && equipment_ids.length > 0,
      Boolean(owner_id),
    ].filter(Boolean).length;

  if (selectors !== 1) {
    return res.status(400).json({
      error:
        "Provide exactly one of: equipment_id, a non-empty equipment_ids array, or owner_id",
    });
  }

  let pool;
  let transaction;
  try {
    pool = await poolPromise;
    transaction = new sql.Transaction(pool);
    await transaction.begin();
    const request = transaction.request();

    let result;
    if (equipment_id) {
      result = await equipmentModel.unassignById(request, equipment_id, status);
    } else if (Array.isArray(equipment_ids) && equipment_ids.length) {
      result = await equipmentModel.unassignByIds(request, equipment_ids, status);
    } else {
      result = await equipmentModel.unassignByOwnerId(request, owner_id, status);
    }

    if (!result || !result.recordset || result.recordset.length === 0) {
      await transaction.rollback();
      return res.status(404).json({ error: 'No matching equipment found' });
    }

    await transaction.commit();
    // return single object for single id, otherwise array
    return res.json(result.recordset.length === 1 ? result.recordset[0] : result.recordset);
  } catch (err) {
    try {
      if (transaction) await transaction.rollback();
    } catch (rbErr) {
      console.error('Rollback failed', rbErr);
    }
    console.error('unassign error', err);
    return res.status(500).json({ error: err.message });
  }
}

async function getById(req, res, next) {
  try {
    const equipment = await equipmentModel.findById(req.params.id);
    if (!equipment) {
      return res.status(404).json({ error: 'Equipment not found' });
    }
    const [withFields] = await attachCustomFields([equipment]);
    res.json(withFields);
  } catch (err) {
    next(err);
  }
}

async function updateOwner(req, res, next) {
  try {
    const equipment = await equipmentModel.updateOwner(req.params.id, req.body.owner_id);
    if (!equipment) {
      return res.status(404).json({ error: 'Equipment not found' });
    }
    res.json(equipment);
  } catch (err) {
    next(err);
  }
}

// Full detail edit - fixing a typo, recording a RAM upgrade, changing status.
// Accepts category and department as either name or id.
async function update(req, res, next) {
  try {
    const existing = await equipmentModel.findById(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Equipment not found' });
    }

    let category_id = req.body.category_id;
    if (!category_id && req.body.category) {
      const cat = await categoryModel.findByName(req.body.category);
      if (!cat) {
        return res.status(400).json({
          error: `Unknown category "${req.body.category}". See GET /api/categories.`,
        });
      }
      category_id = cat.category_id;
    }

    let department_id = req.body.department_id;
    if (!department_id && req.body.department) {
      const dept = await departmentModel.findByCode(req.body.department);
      if (!dept) {
        return res.status(400).json({
          error: `Unknown department "${req.body.department}". See GET /api/departments.`,
        });
      }
      department_id = dept.department_id;
    }

    // Don't let an edit hand this asset code or service tag to a second record
    if (req.body.equipment_code && req.body.equipment_code !== existing.equipment_code) {
      const clash = await equipmentModel.findByEquipmentCode(req.body.equipment_code);
      if (clash && clash.equipment_id !== Number(req.params.id)) {
        return res.status(409).json({
          error: `Asset code "${req.body.equipment_code}" is already used by equipment_id ${clash.equipment_id}`,
        });
      }
    }
    if (req.body.service_tag && req.body.service_tag !== existing.service_tag) {
      const clash = await equipmentModel.findByServiceTag(req.body.service_tag);
      if (clash && clash.equipment_id !== Number(req.params.id)) {
        return res.status(409).json({
          error: `Service tag "${req.body.service_tag}" is already used by equipment_id ${clash.equipment_id}`,
        });
      }
    }

    const updated = await equipmentModel.update(req.params.id, {
      ...req.body, category_id, department_id,
    });
    res.json({ message: 'Equipment updated', equipment: updated });
  } catch (err) {
    next(err);
  }
}

// Admin only. Refused while anything still references the equipment - the
// database would reject it anyway via the foreign keys, but checking first
// lets us say exactly what is blocking it rather than surfacing a raw SQL error.
//
// Retiring (PUT status = 'Retired - IT Stock') is usually the better move for a
// real device; delete is for records entered by mistake.
async function remove(req, res, next) {
  try {
    const existing = await equipmentModel.findById(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Equipment not found' });
    }

    const refs = await equipmentModel.countReferences(req.params.id);
    const total = Object.values(refs).reduce((a, b) => a + b, 0);

    if (total > 0) {
      const blocking = [];
      if (refs.borrow_records > 0)      blocking.push(`${refs.borrow_records} borrow record(s)`);
      if (refs.antivirus_records > 0)   blocking.push(`${refs.antivirus_records} antivirus record(s)`);
      if (refs.server_usage_records > 0) blocking.push(`${refs.server_usage_records} server usage record(s)`);
      if (refs.ssd_upgrade_records > 0) blocking.push(`${refs.ssd_upgrade_records} SSD upgrade record(s)`);
      if (refs.replacement_records > 0) blocking.push(`${refs.replacement_records} replacement record(s)`);

      return res.status(409).json({
        error: `Cannot delete: this equipment has history attached`,
        references: refs,
        blocking,
        hint: "Set status to 'Retired - IT Stock' via PUT /api/equipment/:id instead - that keeps the history.",
      });
    }

    const deleted = await equipmentModel.remove(req.params.id, req.user);
    res.json({
      message: `Equipment "${deleted.device_name || deleted.computer_name || req.params.id}" moved to the recycle bin`,
      equipment: deleted,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getAll,
  getCategories,
  getById,
  updateOwner,
  update,
  unassign,
  remove,
};
