const employeeModel = require('../models/employeeModel');
const departmentModel = require('../models/departmentModel');

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
    const { items_still_out, ...countable } = refs;
    const total = Object.values(countable).reduce((a, b) => a + b, 0);

    if (total > 0) {
      // Two very different situations, so say which one it is. One is fixable
      // by the user; the other is a deliberate refusal to destroy history.
      const fixable = [];
      if (items_still_out > 0) {
        fixable.push(`${items_still_out} item(s) still on loan - process the returns first`);
      }
      if (refs.owned_equipment > 0) {
        fixable.push(`${refs.owned_equipment} device(s) still assigned - reassign them first`);
      }

      const historyOnly = fixable.length === 0;

      return res.status(409).json({
        error: historyOnly
          ? `Cannot delete ${existing.full_name}: they have past records that would be lost`
          : `Cannot delete ${existing.full_name}: there are things to sort out first`,
        references: refs,
        blocking: fixable,
        hint: historyOnly
          ? 'Their loan history has to keep a real name attached, or it becomes unusable. Set is_active to false instead - they disappear from dropdowns but the history stays intact.'
          : 'Clear the items listed above, then try again. If you only want them out of the dropdowns, set is_active to false instead.',
      });
    }

    const deleted = await employeeModel.remove(req.params.id);
    res.json({ message: 'Employee deleted', employee: deleted });
  } catch (err) {
    next(err);
  }
}

module.exports = { getAll, search, getById, getReplacements, create, update, remove };
