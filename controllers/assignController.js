const { sql, poolPromise } = require('../config/db');
const equipmentModel = require('../models/equipmentModel');
const employeeModel = require('../models/employeeModel');
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
    const pool = await poolPromise;
    const request = pool.request();

    let query = `
      SELECT e.*,
             c.category_name,
             s.status_name,
             -- Always null for stock, but present so the column set matches
             -- the replacement page and one table component serves both.
             CAST(NULL AS NVARCHAR(100)) AS owner_name,
             CAST(NULL AS NVARCHAR(100)) AS owner_position,
             CAST(NULL AS VARCHAR(20))   AS owner_department,
             -- What the dropdown shows. Falls through name, hostname, model
             -- and asset code so a device is never an unlabelled row.
             COALESCE(e.computer_name, e.device_name, e.device_model, e.asset_code,
                      CONCAT('Equipment ', e.equipment_id)) AS display_name
      FROM dbo.equipment e
      LEFT JOIN dbo.category c ON e.category_id = c.category_id
      LEFT JOIN dbo.equipment_status s ON e.status_id = s.status_id
      -- No owner is not enough: a wall-mounted camera has no owner either.
      -- is_assignable marks what can actually be handed to a person.
      WHERE e.owner_id IS NULL
        AND s.is_assignable = 1
    `;

    if (q) {
      query += ` AND (
        e.computer_name LIKE @q OR
        e.device_name   LIKE @q OR
        e.asset_code    LIKE @q OR
        e.service_tag   LIKE @q OR
        e.serial_no     LIKE @q OR
        e.device_model  LIKE @q
      )`;
      request.input('q', sql.NVarChar, `%${q}%`);
    }
    if (category) {
      query += ' AND c.category_name = @category';
      request.input('category', sql.VarChar, category);
    }
    if (status) {
      query += ' AND e.status = @status';
      request.input('status', sql.VarChar, status);
    }
    if (location) {
      query += ' AND e.location = @location';
      request.input('location', sql.VarChar, location);
    }

    query += ' ORDER BY c.category_name, display_name';

    const result = await request.query(query);
    const rows = result.recordset;

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
    const pool = await poolPromise;
    const request = pool.request();

    let query = `
      SELECT emp.employee_id,
             emp.full_name,
             emp.position,
             emp.staff_code,
             emp.location,
             emp.department_id,
             d.department_code,
             d.department_name,
             (SELECT COUNT(*) FROM dbo.equipment e WHERE e.owner_id = emp.employee_id)
               AS current_equipment_count
      FROM dbo.employee emp
      LEFT JOIN dbo.department d ON emp.department_id = d.department_id
      WHERE emp.is_active = 1
    `;

    if (position) {
      query += ' AND emp.position = @position';
      request.input('position', sql.NVarChar, position);
    }
    if (department) {
      query += ' AND d.department_code = @department';
      request.input('department', sql.VarChar, department);
    }
    if (q) {
      query += ' AND (emp.full_name LIKE @q OR emp.staff_code LIKE @q)';
      request.input('q', sql.NVarChar, `%${q}%`);
    }

    query += ' ORDER BY emp.full_name';

    const result = await request.query(query);
    res.json({
      count: result.recordset.length,
      position: position || null,
      employees: result.recordset,
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
    const pool = await poolPromise;

    const [positions, statuses, categories, locations] = await Promise.all([
      pool.request().query(`
        SELECT position, COUNT(*) AS employee_count
        FROM dbo.employee
        WHERE position IS NOT NULL AND LTRIM(RTRIM(position)) <> '' AND is_active = 1
        GROUP BY position ORDER BY position`),
      pool.request().query(`
        SELECT status_id, status_name, description, is_assignable
        FROM dbo.equipment_status
        WHERE is_active = 1 ORDER BY sort_order`),
      pool.request().query(`
        SELECT c.category_id, c.category_name,
               (SELECT COUNT(*) FROM dbo.equipment e
                 WHERE e.category_id = c.category_id AND e.owner_id IS NULL) AS available_count
        FROM dbo.category c WHERE c.is_active = 1 ORDER BY c.category_name`),
      pool.request().query(`
        SELECT DISTINCT location FROM dbo.equipment
        WHERE location IS NOT NULL AND owner_id IS NULL ORDER BY location`),
    ]);

    res.json({
      positions: positions.recordset,
      statuses: statuses.recordset,
      categories: categories.recordset,
      locations: locations.recordset.map((r) => r.location),
    });
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

    const pool = await poolPromise;
    const result = await pool
      .request()
      .input('equipment_id', sql.Int, equipment_id)
      .input('employee_id', sql.Int, employee_id)
      .input('status', sql.VarChar, status || 'Working/Using')
      .input('assigned_date', sql.Date, assigned_date || new Date())
      .query(`
        UPDATE dbo.equipment
        SET owner_id      = @employee_id,
            status        = @status,
            status_id     = (SELECT status_id FROM dbo.equipment_status WHERE status_name = @status),
            assigned_date = @assigned_date,
            -- Both follow the owner. Asking for them separately invites the
            -- device and the person to disagree about where they are.
            department_id = (SELECT department_id FROM dbo.employee WHERE employee_id = @employee_id),
            location      = COALESCE(
                              (SELECT location FROM dbo.employee WHERE employee_id = @employee_id),
                              location)
        OUTPUT INSERTED.*
        WHERE equipment_id = @equipment_id
      `);

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