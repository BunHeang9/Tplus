const equipmentModel = require('../models/equipmentModel');
const employeeModel = require('../models/employeeModel');
const filterModel = require('../models/filterModel');
const categoryColumns = require('../utils/categoryColumns');

// The assign page: pick an unowned device, pick a position, pick someone in
// that position, choose a status.
//
// Each dropdown narrows the next, so the endpoints mirror that - positions
// come with a headcount, and the employee list takes a position filter.

// GET /api/assign/available?q=probook&category=Laptop
//
// Only equipment with no owner. Searchable by computer name, asset code or
// service tag, since whoever is standing at the shelf may have any of the
// three in front of them.
async function getAvailableEquipment(req, res, next) {
  const { q, category, status, location } = req.query;

  try {
    const rows = await equipmentModel.findAvailableForAssign({ q, category, status, location });

    // With a category chosen, show that category's configured columns - the
    // same ones the equipment page uses. Choosing a laptop from stock without
    // seeing its CPU and RAM is guesswork.
    const view = await categoryColumns.buildFor(category);

    if (!view) {
      return res.json({
        count: rows.length,
        columns: [
          { field: 'equipment_id',  header: 'No.' },
          { field: 'display_name',  header: 'Device' },
          { field: 'category_name', header: 'Category' },
          { field: 'asset_code',    header: 'Asset Code' },
          { field: 'service_tag',   header: 'Service Tag' },
          { field: 'status',        header: 'Status' },
          { field: 'location',      header: 'Location' },
        ],
        equipment: rows,
      });
    }

    const customValues = await categoryColumns.customValuesFor(
      view, rows.map((r) => r.equipment_id)
    );

    res.json({
      category: view.category_name,
      count: rows.length,
      columns: view.headers,
      equipment: rows.map((r) => ({
        ...categoryColumns.project(r, view.headers, customValues[r.equipment_id] || {}),
        // owner_name is in the header list but always null here - these are
        // stock items. Kept so the column set matches the replacement page.
        category_name: r.category_name,
        display_name: r.display_name,
      })),
    });
  } catch (err) {
    next(err);
  }
}

// GET /api/assign/employees?position=IT%20Developer&q=fong
//
// Employees filtered by position, and searchable by name within that - a
// position with 19 people still needs narrowing.
async function getEmployees(req, res, next) {
  const { position, q, department } = req.query;

  try {
    const employees = await employeeModel.findForAssign({ position, department, q });
    res.json({
      count: employees.length,
      position: position || null,
      employees,
    });
  } catch (err) {
    next(err);
  }
}

// GET /api/assign/form-data
//
// Everything the page needs on load, in one call rather than four.
async function getFormData(req, res, next) {
  try {
    res.json(await filterModel.getAssignFormData());
  } catch (err) {
    next(err);
  }
}

// POST /api/assign  (admin)
// { equipment_id, employee_id, status, assigned_date }
//
// Department and location come from the employee rather than being asked for
// again - the person's record already knows both.
async function assign(req, res, next) {
  const { equipment_id, employee_id, status, assigned_date } = req.body;

  if (!equipment_id || !employee_id) {
    return res.status(400).json({
      error: 'equipment_id and employee_id are required',
      example: { equipment_id: 733, employee_id: 22, status: 'Working/Using' },
    });
  }

  try {
    const equipment = await equipmentModel.findById(equipment_id);
    if (!equipment) return res.status(404).json({ error: 'Equipment not found' });

    if (equipment.owner_id) {
      return res.status(409).json({
        error: `That device already belongs to ${equipment.owner_name}`,
        current_owner: equipment.owner_name,
        hint: 'Unassign it first with POST /api/equipment/unassign.',
      });
    }

    const employee = await employeeModel.findById(employee_id);
    if (!employee) return res.status(404).json({ error: 'Employee not found' });

    await equipmentModel.assignToEmployee(equipment_id, employee_id, { status, assignedDate: assigned_date });

    const updated = await equipmentModel.findById(equipment_id);

    res.json({
      message: `Assigned to ${employee.full_name}`,
      equipment: updated,
      inherited_from_employee: {
        department: !!employee.department_id,
        location: !!employee.location,
      },
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getAvailableEquipment,
  getEmployees,
  getFormData,
  assign,
};
