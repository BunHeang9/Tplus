const equipmentModel = require('../models/equipmentModel');
const employeeModel = require('../models/employeeModel');
const categoryModel = require('../models/categoryModel');
const departmentModel = require('../models/departmentModel');

// Add one new device into stock. Deliberately one-at-a-time: every unit has
// its own asset code, service tag and often different specs, so batching
// would just mean entering the same number of unique values anyway.
async function addStock(req, res, next) {
  const { category, category_id, department, department_id, equipment_code, service_tag } = req.body;

  if (!category && !category_id) {
    return res.status(400).json({
      error: 'category or category_id is required (e.g. Laptop, Desktop, Server, Monitor, CCTV)',
    });
  }

  try {
    // The frontend may send either the id or the name - resolve names to ids
    // so the caller doesn't have to look them up first.
    let resolvedCategoryId = category_id;
    if (!resolvedCategoryId) {
      const cat = await categoryModel.findByName(category);
      if (!cat) {
        return res.status(400).json({
          error: `Unknown category "${category}". Use GET /api/categories to see the valid list.`,
        });
      }
      resolvedCategoryId = cat.category_id;
    }

    let resolvedDepartmentId = department_id;
    if (!resolvedDepartmentId && department) {
      const dept = await departmentModel.findByCode(department);
      if (!dept) {
        return res.status(400).json({
          error: `Unknown department "${department}". Use GET /api/departments to see the valid list.`,
        });
      }
      resolvedDepartmentId = dept.department_id;
    }

    // Refuse duplicates rather than silently creating a second record
    // for the same physical machine.
    if (equipment_code) {
      const existing = await equipmentModel.findByEquipmentCode(equipment_code);
      if (existing) {
        return res.status(409).json({
          error: `Asset code "${equipment_code}" is already used by equipment_id ${existing.equipment_id}`,
          existing,
        });
      }
    }
    if (service_tag) {
      const existingTag = await equipmentModel.findByServiceTag(service_tag);
      if (existingTag) {
        return res.status(409).json({
          error: `Service tag "${service_tag}" is already used by equipment_id ${existingTag.equipment_id}`,
          existing: existingTag,
        });
      }
    }

    const equipment = await equipmentModel.createStock({
      ...req.body,
      category_id: resolvedCategoryId,
      department_id: resolvedDepartmentId,
    });
    res.status(201).json({
      message: 'Equipment added to stock (unassigned)',
      equipment,
    });
  } catch (err) {
    next(err);
  }
}

// Hand a stock device to an employee. The employee simply gains another
// device - nothing about their existing equipment changes.
async function assignStock(req, res, next) {
  const { equipment_id, employee_id, full_name } = req.body;

  if (!equipment_id) {
    return res.status(400).json({ error: 'equipment_id is required' });
  }
  if (!employee_id && !full_name) {
    return res.status(400).json({ error: 'Either employee_id or full_name is required' });
  }

  try {
    // Load the employee so the device can inherit their department and
    // location - no point making the caller retype what we already know.
    let employee;
    if (employee_id) {
      employee = await employeeModel.findById(employee_id);
      if (!employee) {
        return res.status(404).json({ error: `No employee found with id ${employee_id}` });
      }
    } else {
      employee = await employeeModel.findByName(full_name);
      if (!employee) {
        return res.status(404).json({ error: `No employee found with name "${full_name}"` });
      }
    }
    const resolvedEmployeeId = employee.employee_id;

    const current = await equipmentModel.findWithOwnerName(equipment_id);
    if (!current) {
      return res.status(404).json({ error: `No equipment found with id ${equipment_id}` });
    }

    // Don't silently overwrite someone else's device - make it a deliberate act.
    if (current.owner_id && current.owner_id !== resolvedEmployeeId) {
      return res.status(409).json({
        error: `This equipment is already assigned to ${current.current_owner}. Use PUT /api/equipment/${equipment_id}/owner to reassign it deliberately.`,
        current_owner: current.current_owner,
      });
    }

    // Department and location default to the employee's own. They can still
    // be overridden for the exception case - a device kept at a different
    // site to the person, for instance.
    let resolvedDepartmentId = req.body.department_id;
    if (!resolvedDepartmentId && req.body.department) {
      const dept = await departmentModel.findByCode(req.body.department);
      if (!dept) {
        return res.status(400).json({
          error: `Unknown department "${req.body.department}". Use GET /api/departments to see the valid list.`,
        });
      }
      resolvedDepartmentId = dept.department_id;
    }
    if (!resolvedDepartmentId) {
      resolvedDepartmentId = employee.department_id;
    }

    const resolvedLocation = req.body.location || employee.location;

    const equipment = await equipmentModel.assign(equipment_id, {
      owner_id: resolvedEmployeeId,
      assigned_date: req.body.assigned_date,
      computer_name: req.body.computer_name,
      ip_address: req.body.ip_address,
      location: resolvedLocation,
      department_id: resolvedDepartmentId,
      // Once assigned it is no longer stock - default it to the owned status
      // unless the caller deliberately sets something else (e.g. 'Broken').
      status: req.body.status || 'Working/Using',
    });

    res.json({
      message: 'Equipment assigned',
      equipment,
      inherited_from_employee: {
        department: !req.body.department && !req.body.department_id,
        location: !req.body.location,
      },
    });
  } catch (err) {
    next(err);
  }
}

async function getAvailable(req, res, next) {
  try {
    const equipment = await equipmentModel.findAvailable(
      req.query.category,
      req.query.include_installed
    );
    res.json({ count: equipment.length, equipment });
  } catch (err) {
    next(err);
  }
}

async function getByDate(req, res, next) {
  const { from, to } = req.query;
  if (!from) {
    return res.status(400).json({
      error: 'Query parameter "from" is required, e.g. ?from=2026-01-01&to=2026-01-31',
    });
  }
  try {
    const equipment = await equipmentModel.findByDateRange(from, to || from);
    res.json({ from, to: to || from, count: equipment.length, equipment });
  } catch (err) {
    next(err);
  }
}

module.exports = { addStock, assignStock, getAvailable, getByDate };
