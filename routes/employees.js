const express = require('express');
const router = express.Router();
const { sql, poolPromise } = require('../config/db');
const { authenticate, requireAdmin } = require('../middleware/auth');

// GET /api/employees
// List all employees (basic info only - use /search for full profile)
router.get('/', authenticate, async (req, res) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request().query(`
      SELECT employee_id, full_name, staff_code, phone, sex, department, location, position
      FROM dbo.employee
      ORDER BY full_name
    `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/employees/search?name=Fongmoua
// THIS IS THE MAIN ONE: search by name, get employee info + every device they own
// (laptops, servers, monitors) + server platform info + antivirus status, all in one call.
// This is what powers "search employee, see everything" on the frontend.
router.get('/search', authenticate, async (req, res) => {
  const { name } = req.query;
  if (!name) {
    return res.status(400).json({ error: 'Query parameter "name" is required, e.g. /api/employees/search?name=Fongmoua' });
  }
  try {
    const pool = await poolPromise;
    const result = await pool
      .request()
      .input('name', sql.NVarChar, `%${name}%`)
      .query(`
        SELECT
          emp.employee_id,
          emp.full_name AS owner_name,
          emp.position AS employee_position,
          emp.department AS employee_department,
          emp.location AS employee_location,
          emp.sex,
          emp.staff_code,
          emp.phone,
          e.equipment_id,
          e.category,
          e.device_type,
          e.computer_name,
          e.device_model,
          e.equipment_code AS asset_code,
          e.service_tag,
          e.mac_address,
          e.ip_address,
          e.manufacturer,
          e.cpu,
          e.ram,
          e.hd,
          e.windows_license,
          e.av_license,
          e.department AS device_department,
          e.location AS device_location,
          e.status AS device_status,
          e.remark AS device_remark,
          su.platform AS server_platform,
          su.os_type AS server_os_type,
          su.os_version AS server_os_version,
          av.antivirus_status,
          av.plan_date AS antivirus_plan_date,
          av.due_date AS antivirus_due_date
        FROM dbo.employee emp
        LEFT JOIN dbo.equipment e ON e.owner_id = emp.employee_id
        LEFT JOIN dbo.server_usage su ON su.equipment_id = e.equipment_id
        LEFT JOIN dbo.antivirus_install av ON av.equipment_id = e.equipment_id
        WHERE emp.full_name LIKE @name
        ORDER BY emp.full_name, e.category, e.computer_name
      `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/employees/:id
// Single employee's basic record
router.get('/:id', authenticate, async (req, res) => {
  try {
    const pool = await poolPromise;
    const result = await pool
      .request()
      .input('id', sql.Int, req.params.id)
      .query('SELECT * FROM dbo.employee WHERE employee_id = @id');
    if (result.recordset.length === 0) {
      return res.status(404).json({ error: 'Employee not found' });
    }
    res.json(result.recordset[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/employees/:id/replacements
// Full old-device / new-device replacement history for one employee
router.get('/:id/replacements', authenticate, async (req, res) => {
  try {
    const pool = await poolPromise;
    const result = await pool
      .request()
      .input('id', sql.Int, req.params.id)
      .query(`
        SELECT
          dr.replacement_id,
          old_eq.device_model AS old_device_model,
          old_eq.service_tag AS old_service_tag,
          old_eq.equipment_code AS old_asset_code,
          dr.old_device_status,
          dr.old_device_location AS location_of_old,
          dr.old_bag, dr.old_mouse, dr.old_keyboard,
          new_eq.computer_name AS new_computer_name,
          new_eq.device_model AS new_device_model,
          new_eq.service_tag AS new_service_tag,
          new_eq.product_id AS new_product_id,
          new_eq.equipment_code AS new_asset_code,
          dr.new_bag, dr.new_mouse, dr.new_keyboard,
          dr.replacement_date,
          dr.new_owner_location
        FROM dbo.device_replacement dr
        LEFT JOIN dbo.equipment old_eq ON dr.old_equipment_id = old_eq.equipment_id
        LEFT JOIN dbo.equipment new_eq ON dr.new_equipment_id = new_eq.equipment_id
        WHERE dr.employee_id = @id
        ORDER BY dr.replacement_date
      `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/employees
// Create a new employee
router.post('/', authenticate, requireAdmin, async (req, res) => {
  const { full_name, staff_code, phone, sex, department, location, position } = req.body;
  if (!full_name) {
    return res.status(400).json({ error: 'full_name is required' });
  }
  try {
    const pool = await poolPromise;
    const result = await pool
      .request()
      .input('full_name', sql.NVarChar, full_name)
      .input('staff_code', sql.VarChar, staff_code || null)
      .input('phone', sql.VarChar, phone || null)
      .input('sex', sql.VarChar, sex || null)
      .input('department', sql.VarChar, department || null)
      .input('location', sql.VarChar, location || null)
      .input('position', sql.NVarChar, position || null)
      .query(`
        INSERT INTO dbo.employee (full_name, staff_code, phone, sex, department, location, position)
        OUTPUT INSERTED.*
        VALUES (@full_name, @staff_code, @phone, @sex, @department, @location, @position)
      `);
    res.status(201).json(result.recordset[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/employees/:id
// Update an existing employee (partial update - only sends fields that were provided)
router.put('/:id', authenticate, requireAdmin, async (req, res) => {
  const { full_name, staff_code, phone, sex, department, location, position } = req.body;
  try {
    const pool = await poolPromise;
    const result = await pool
      .request()
      .input('id', sql.Int, req.params.id)
      .input('full_name', sql.NVarChar, full_name)
      .input('staff_code', sql.VarChar, staff_code)
      .input('phone', sql.VarChar, phone)
      .input('sex', sql.VarChar, sex)
      .input('department', sql.VarChar, department)
      .input('location', sql.VarChar, location)
      .input('position', sql.NVarChar, position)
      .query(`
        UPDATE dbo.employee
        SET full_name = COALESCE(@full_name, full_name),
            staff_code = COALESCE(@staff_code, staff_code),
            phone = COALESCE(@phone, phone),
            sex = COALESCE(@sex, sex),
            department = COALESCE(@department, department),
            location = COALESCE(@location, location),
            position = COALESCE(@position, position)
        OUTPUT INSERTED.*
        WHERE employee_id = @id
      `);
    if (result.recordset.length === 0) {
      return res.status(404).json({ error: 'Employee not found' });
    }
    res.json(result.recordset[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
