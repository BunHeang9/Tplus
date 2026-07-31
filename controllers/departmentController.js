const departmentModel = require('../models/departmentModel');

async function getAll(req, res, next) {
  try {
    res.json(await departmentModel.findAll());
  } catch (err) { next(err); }
}

async function getById(req, res, next) {
  try {
    const dept = await departmentModel.findById(req.params.id);
    if (!dept) return res.status(404).json({ error: 'Department not found' });
    res.json(dept);
  } catch (err) { next(err); }
}

async function create(req, res, next) {
  const { department_code } = req.body;
  if (!department_code) {
    return res.status(400).json({ error: 'department_code is required' });
  }
  try {
    const existing = await departmentModel.findByCode(department_code);
    if (existing) {
      return res.status(409).json({
        error: `Department code "${department_code}" already exists`,
        existing,
      });
    }
    res.status(201).json(await departmentModel.create(req.body));
  } catch (err) { next(err); }
}

async function update(req, res, next) {
  try {
    const dept = await departmentModel.update(req.params.id, req.body);
    if (!dept) return res.status(404).json({ error: 'Department not found' });
    res.json(dept);
  } catch (err) { next(err); }
}

// Refused while anything still points at it. Deactivating (PUT is_active:false)
// is the alternative - it hides the department from dropdowns while leaving
// existing employees and equipment untouched.
async function remove(req, res, next) {
  try {
    const existing = await departmentModel.findById(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Department not found' });
    }

    const usage = await departmentModel.countUsage(req.params.id);
    if (usage.employee_count > 0 || usage.equipment_count > 0) {
      return res.status(409).json({
        error: `Cannot delete ${existing.department_code}: it is still in use`,
        references: usage,
        hint: 'Move those records to another department first, or set is_active to false to hide it from dropdowns instead.',
      });
    }

    const deleted = await departmentModel.remove(req.params.id);
    res.json({ message: 'Department deleted', department: deleted });
  } catch (err) {
    next(err);
  }
}

module.exports = { getAll, getById, create, update, remove };
