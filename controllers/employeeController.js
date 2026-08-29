const employeeModel = require('../models/employeeModel');
const departmentModel = require('../models/departmentModel');
const equipmentModel = require('../models/equipmentModel');
const viewColumnModel = require('../models/viewColumnModel');
const customFieldModel = require('../models/customFieldModel');
const softwareLicenseModel = require('../models/softwareLicenseModel');
const partModel = require('../models/partModel');

// A fixed pair rather than free text - locking it down here is what lets the
// frontend safely use a dropdown instead of a text box.
const SEX_OPTIONS = ['Male', 'Female'];

function validateSex(value) {
  if (value === undefined || value === null || value === '') return { ok: true };
  if (!SEX_OPTIONS.includes(value)) {
    return { ok: false, error: `sex must be one of: ${SEX_OPTIONS.join(', ')}` };
  }
  return { ok: true };
}

// Accepts either department_id or a department code, so callers can use
// whichever they have without a separate lookup first.
async function resolveDepartmentId(body) {
  if (body.department_id) return { id: body.department_id };
  if (!body.department) return { id: undefined };
  const dept = await departmentModel.findByCode(body.department);
  if (!dept) {
    return { error: `Unknown department "${body.department}". Use GET /api/departments to see the valid list.` };
  }
  return { id: dept.department_id };
}

// Controllers deal with HTTP concerns only: reading the request,
// checking inputs, and shaping the response. All SQL lives in the model.

// ?include_inactive=true to see leavers as well as current staff.
async function getAll(req, res, next) {
  try {
    const employees = await employeeModel.findAll(req.query.include_inactive === 'true');
    res.json(employees);
  } catch (err) {
    next(err);
  }
}

async function search(req, res, next) {
  const { name } = req.query;
  if (!name) {
    return res.status(400).json({
      error: 'Query parameter "name" is required, e.g. /api/employees/search?name=Fongmoua',
    });
  }
  try {
    const results = await employeeModel.searchWithEquipment(name);
    res.json(results);
  } catch (err) {
    next(err);
  }
}

async function getById(req, res, next) {
  try {
    const employee = await employeeModel.findById(req.params.id);
    if (!employee) {
      return res.status(404).json({ error: 'Employee not found' });
    }
    res.json(employee);
  } catch (err) {
    next(err);
  }
}

// Columns that describe the *owner*, not the device. They exist so the
// general equipment list can show "who owns this laptop" - useful there, but
// redundant (and a source of blank fields) on an employee's own page, where
// the owner is already known: it's the page you're on. Stripped out below so
// device cards only carry fields that are actually about the device.
const OWNER_DERIVED_FIELDS = new Set([
  "owner_name",
  "owner_position",
  "owner_department",
  "owner_department_name",
  "owner_location",
  "owner_staff_code",
]);

// The employee detail page: their own info plus one entry per device they
// own, each shaped by that device's category - the same column/custom-field
// configuration the per-category equipment views use (equipmentViewController),
// so a Computer shows cpu/ram/hd while a Printer shows only what applies to
// printers, instead of one flat row with every field from every category.
async function getFull(req, res, next) {
  try {
    const employee = await employeeModel.findById(req.params.id);
    if (!employee) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    const devices = await equipmentModel.findByOwner(req.params.id);
    const equipmentIds = devices.map((d) => d.equipment_id);

    const [licensesByEquipment, customValuesByEquipment] = await Promise.all([
      equipmentIds.length ? softwareLicenseModel.getLicensesForMany(equipmentIds) : {},
      equipmentIds.length ? customFieldModel.getValuesForMany(equipmentIds) : {},
    ]);

    // Column config is per category, not per device - fetch it once for each
    // category actually present rather than once per device.
    const columnsByCategory = {};
    const customFieldsByCategory = {};
    for (const categoryId of new Set(devices.map((d) => d.category_id))) {
      columnsByCategory[categoryId] = await viewColumnModel.findByCategory(categoryId);
      customFieldsByCategory[categoryId] = await customFieldModel.findByCategory(categoryId);
    }

    const equipment = devices.map((device) => {
      const columns = (columnsByCategory[device.category_id] || []).filter(
        (c) => !OWNER_DERIVED_FIELDS.has(c.field_name),
      );
      const customFields = customFieldsByCategory[device.category_id] || [];
      const customValues = customValuesByEquipment[device.equipment_id] || {};

      const item = { equipment_id: device.equipment_id };
      for (const col of columns) item[col.field_name] = device[col.field_name] ?? null;
      for (const f of customFields) item[f.field_key] = customValues[f.field_key] ?? null;

      return {
        equipment_id: device.equipment_id,
        category: device.category_name,
        // Travels with the data so the frontend renders each card generically
        // (loop columns, print header: item[field]) instead of hardcoding
        // which fields belong to which category.
        columns: [
          ...columns.map((c) => ({ field: c.field_name, header: c.header_text })),
          ...customFields.map((f) => ({ field: f.field_key, header: f.field_label, custom: true })),
        ],
        item,
        licenses: licensesByEquipment[device.equipment_id] || [],
      };
    });

    res.json({ employee, equipment });
  } catch (err) {
    next(err);
  }
}

// GET /api/employees/:id/part-replacements
// Every part swapped across every device this employee currently owns - the
// part-level equivalent of the (now retired) whole-device replacement history.
async function getPartReplacements(req, res, next) {
  try {
    const employee = await employeeModel.findById(req.params.id);
    if (!employee) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    const replacements = await partModel.findByEmployee(req.params.id);
    res.json({
      employee_id: Number(req.params.id),
      full_name: employee.full_name,
      count: replacements.length,
      replacements,
    });
  } catch (err) {
    next(err);
  }
}

async function getReplacements(req, res, next) {
  try {
    const history = await employeeModel.findReplacementHistory(req.params.id);
    res.json(history);
  } catch (err) {
    next(err);
  }
}

async function create(req, res, next) {
  if (!req.body.full_name) {
    return res.status(400).json({ error: 'full_name is required' });
  }
  const sexCheck = validateSex(req.body.sex);
  if (!sexCheck.ok) return res.status(400).json({ error: sexCheck.error });

  try {
    const resolved = await resolveDepartmentId(req.body);
    if (resolved.error) return res.status(400).json({ error: resolved.error });

    const employee = await employeeModel.create({ ...req.body, department_id: resolved.id });
    res.status(201).json(employee);
  } catch (err) {
    next(err);
  }
}

async function update(req, res, next) {
  const sexCheck = validateSex(req.body.sex);
  if (!sexCheck.ok) return res.status(400).json({ error: sexCheck.error });

  try {
    const resolved = await resolveDepartmentId(req.body);
    if (resolved.error) return res.status(400).json({ error: resolved.error });

    const employee = await employeeModel.update(req.params.id, { ...req.body, department_id: resolved.id });
    if (!employee) {
      return res.status(404).json({ error: 'Employee not found' });
    }
    res.json(employee);
  } catch (err) {
    next(err);
  }
}

// Refused while the employee still owns equipment or appears in loan history.
// The database would reject it anyway via the foreign keys, but checking first
// lets us say exactly what is blocking it rather than surfacing a raw SQL error.
async function remove(req, res, next) {
  try {
    const existing = await employeeModel.findById(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    const refs = await employeeModel.countReferences(req.params.id);

    // items_still_out is a subset of borrow_records, so exclude it from the total
    const { borrow_records, items_still_out, ...countable } = refs;
    const total = Object.values(countable).reduce((a, b) => a + b, 0);

    if (total > 0) {
      // Two very different situations, so say which one it is. One is fixable
      // by the user; the other is a deliberate refusal to destroy history.
      const fixable = [];
      if (items_still_out > 0) {
        fixable.push(
          `${items_still_out} item(s) still on loan - process the returns first`,
        );
      }
      if (refs.owned_equipment > 0) {
        fixable.push(
          `${refs.owned_equipment} device(s) still assigned - reassign them first`,
        );
      }

      return res.status(409).json({
        error: `Cannot delete ${existing.full_name}: there are things to sort out first`,
        references: refs,
        blocking: fixable,
        hint: "Clear the items listed above, then try again. Completed borrow history will keep the saved employee name after deletion.",
      });
    }

    const deleted = await employeeModel.remove(
      req.params.id,
      existing.full_name,
      req.user,
    );
    if (!deleted) {
      return res.status(404).json({ error: "Employee not found" });
    }
    res.json({ message: "Employee deleted", employee: existing });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getAll, search, getById, getFull, getReplacements, getPartReplacements,
  create, update, remove, SEX_OPTIONS,
};
