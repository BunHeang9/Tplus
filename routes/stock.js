const express = require('express');
const router = express.Router();
const { sql, poolPromise } = require('../config/db');
const { authenticate, requireAdmin } = require('../middleware/auth');

// ==============================================================
// POST /api/stock/add        (admin only)
// Add ONE new piece of equipment into stock.
//
// Body example:
// {
//   "category": "Computer",
//   "device_type": "Laptop",
//   "device_model": "HP ProBook 440 G10",
//   "manufacturer": "HP",
//   "equipment_code": "AIT0250",
//   "service_tag": "5CD4414ABC",
//   "mac_address": "68c6ac2b1234",
//   "ip_address": "166.24.12.50",
//   "cpu": "i5-1340P",
//   "ram": "16",
//   "hd": "512",
//   "os_type": "Windows 11 Pro",
//   "purchase_date": "2026-01-01",
//   "received_date": "2026-01-05",
//   "location": "IT-Stock-Working",
//   "department": "TIT",
//   "status": "In Stock",
//   "remark": "New batch Jan 2026"
// }
//
// owner_id is deliberately NOT accepted here - new stock starts unassigned.
// Use POST /api/stock/assign to give it to someone.
// ==============================================================
router.post('/add', authenticate, requireAdmin, async (req, res) => {
  const {
    category, device_type, device_model, manufacturer,
    equipment_code, service_tag, serial_no, product_id,
    mac_address, ip_address, os_type, os_version,
    cpu, ram, hd, windows_license, av_license,
    purchase_date, received_date,
    location, department, status, remark,
  } = req.body;

  if (!category) {
    return res.status(400).json({ error: 'category is required (e.g. Computer, Server, Monitor, CCTV)' });
  }

  try {
    const pool = await poolPromise;

    // Warn rather than silently create a duplicate asset code
    if (equipment_code) {
      const dupe = await pool
        .request()
        .input('code', sql.VarChar, equipment_code)
        .query('SELECT equipment_id, computer_name, device_model FROM dbo.equipment WHERE equipment_code = @code');
      if (dupe.recordset.length > 0) {
        return res.status(409).json({
          error: `Asset code "${equipment_code}" is already used by equipment_id ${dupe.recordset[0].equipment_id}`,
          existing: dupe.recordset[0],
        });
      }
    }

    if (service_tag) {
      const dupeTag = await pool
        .request()
        .input('tag', sql.VarChar, service_tag)
        .query('SELECT equipment_id, computer_name FROM dbo.equipment WHERE service_tag = @tag');
      if (dupeTag.recordset.length > 0) {
        return res.status(409).json({
          error: `Service tag "${service_tag}" is already used by equipment_id ${dupeTag.recordset[0].equipment_id}`,
          existing: dupeTag.recordset[0],
        });
      }
    }

    const result = await pool
      .request()
      .input('category', sql.VarChar, category)
      .input('device_type', sql.VarChar, device_type || null)
      .input('device_model', sql.VarChar, device_model || null)
      .input('manufacturer', sql.VarChar, manufacturer || null)
      .input('equipment_code', sql.VarChar, equipment_code || null)
      .input('service_tag', sql.VarChar, service_tag || null)
      .input('serial_no', sql.VarChar, serial_no || null)
      .input('product_id', sql.VarChar, product_id || null)
      .input('mac_address', sql.VarChar, mac_address || null)
      .input('ip_address', sql.VarChar, ip_address || null)
      .input('os_type', sql.VarChar, os_type || null)
      .input('os_version', sql.VarChar, os_version || null)
      .input('cpu', sql.NVarChar, cpu || null)
      .input('ram', sql.NVarChar, ram || null)
      .input('hd', sql.NVarChar, hd || null)
      .input('windows_license', sql.NVarChar, windows_license || null)
      .input('av_license', sql.NVarChar, av_license || null)
      .input('purchase_date', sql.Date, purchase_date || null)
      .input('received_date', sql.Date, received_date || null)
      .input('location', sql.VarChar, location || 'IT-Stock-Working')
      .input('department', sql.VarChar, department || null)
      .input('status', sql.VarChar, status || 'In Stock')
      .input('remark', sql.VarChar, remark || null)
      .query(`
        INSERT INTO dbo.equipment (
          category, device_type, device_model, manufacturer,
          equipment_code, service_tag, serial_no, product_id,
          mac_address, ip_address, os_type, os_version,
          cpu, ram, hd, windows_license, av_license,
          purchase_date, received_date,
          location, department, status, remark, owner_id
        )
        OUTPUT INSERTED.*
        VALUES (
          @category, @device_type, @device_model, @manufacturer,
          @equipment_code, @service_tag, @serial_no, @product_id,
          @mac_address, @ip_address, @os_type, @os_version,
          @cpu, @ram, @hd, @windows_license, @av_license,
          @purchase_date, @received_date,
          @location, @department, @status, @remark, NULL
        )
      `);

    res.status(201).json({
      message: 'Equipment added to stock (unassigned)',
      equipment: result.recordset[0],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==============================================================
// POST /api/stock/assign     (admin only)
// Hand a piece of stock to an employee.
//
// Body:
// {
//   "equipment_id": 800,
//   "employee_id": 22,              // or use "full_name": "Fongmoua"
//   "assigned_date": "2026-01-10",
//   "computer_name": "LIT-Somchai", // hostname given at handover
//   "ip_address": "166.24.12.50",   // optional, if set at handover
//   "location": "VTE",              // where the device now lives
//   "department": "TIT",
//   "status": "Operational"
// }
//
// The employee simply gains another device - nothing about their existing
// equipment is touched (one employee : many devices).
// ==============================================================
router.post('/assign', authenticate, requireAdmin, async (req, res) => {
  const {
    equipment_id, employee_id, full_name,
    assigned_date, computer_name, ip_address,
    location, department, status,
  } = req.body;

  if (!equipment_id) {
    return res.status(400).json({ error: 'equipment_id is required' });
  }
  if (!employee_id && !full_name) {
    return res.status(400).json({ error: 'Either employee_id or full_name is required' });
  }

  try {
    const pool = await poolPromise;

    // Resolve the employee
    let resolvedEmployeeId = employee_id;
    if (!resolvedEmployeeId) {
      const empResult = await pool
        .request()
        .input('full_name', sql.NVarChar, full_name)
        .query('SELECT employee_id FROM dbo.employee WHERE full_name = @full_name');
      if (empResult.recordset.length === 0) {
        return res.status(404).json({ error: `No employee found with name "${full_name}"` });
      }
      resolvedEmployeeId = empResult.recordset[0].employee_id;
    }

    // Check the equipment exists, and flag if it's already assigned
    const eqResult = await pool
      .request()
      .input('id', sql.Int, equipment_id)
      .query(`
        SELECT e.equipment_id, e.owner_id, e.computer_name, e.device_model,
               emp.full_name AS current_owner
        FROM dbo.equipment e
        LEFT JOIN dbo.employee emp ON e.owner_id = emp.employee_id
        WHERE e.equipment_id = @id
      `);

    if (eqResult.recordset.length === 0) {
      return res.status(404).json({ error: `No equipment found with id ${equipment_id}` });
    }

    const current = eqResult.recordset[0];
    if (current.owner_id && current.owner_id !== resolvedEmployeeId) {
      return res.status(409).json({
        error: `This equipment is already assigned to ${current.current_owner}. Use PUT /api/equipment/${equipment_id}/owner to reassign it deliberately.`,
        current_owner: current.current_owner,
      });
    }

    const result = await pool
      .request()
      .input('id', sql.Int, equipment_id)
      .input('owner_id', sql.Int, resolvedEmployeeId)
      .input('assigned_date', sql.Date, assigned_date || null)
      .input('computer_name', sql.NVarChar, computer_name || null)
      .input('ip_address', sql.VarChar, ip_address || null)
      .input('location', sql.VarChar, location || null)
      .input('department', sql.VarChar, department || null)
      .input('status', sql.VarChar, status || null)
      .query(`
        UPDATE dbo.equipment
        SET owner_id      = @owner_id,
            assigned_date = COALESCE(@assigned_date, assigned_date),
            computer_name = COALESCE(@computer_name, computer_name),
            ip_address    = COALESCE(@ip_address, ip_address),
            location      = COALESCE(@location, location),
            department    = COALESCE(@department, department),
            status        = COALESCE(@status, status)
        OUTPUT INSERTED.*
        WHERE equipment_id = @id
      `);

    res.json({
      message: 'Equipment assigned',
      equipment: result.recordset[0],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==============================================================
// GET /api/stock/available
// Everything currently unassigned - i.e. what's sitting in stock
// and can be handed out. Optional ?category=Computer filter.
// ==============================================================
router.get('/available', authenticate, async (req, res) => {
  const { category } = req.query;
  try {
    const pool = await poolPromise;
    const request = pool.request();
    let query = `
      SELECT equipment_id, category, device_type, computer_name, device_model,
             manufacturer, equipment_code, service_tag, mac_address, ip_address,
             cpu, ram, hd, purchase_date, received_date,
             location, department, status, remark
      FROM dbo.equipment
      WHERE owner_id IS NULL
    `;
    if (category) {
      query += ' AND category = @category';
      request.input('category', sql.VarChar, category);
    }
    query += ' ORDER BY received_date DESC, equipment_id DESC';

    const result = await request.query(query);
    res.json({ count: result.recordset.length, equipment: result.recordset });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==============================================================
// GET /api/stock/by-date?from=2026-01-01&to=2026-01-31
// What arrived in a given period - useful for "what did we buy in January".
// Uses received_date, falling back to purchase_date where received is blank.
// ==============================================================
router.get('/by-date', authenticate, async (req, res) => {
  const { from, to } = req.query;
  if (!from) {
    return res.status(400).json({ error: 'Query parameter "from" is required, e.g. ?from=2026-01-01&to=2026-01-31' });
  }
  try {
    const pool = await poolPromise;
    const result = await pool
      .request()
      .input('from', sql.Date, from)
      .input('to', sql.Date, to || from)
      .query(`
        SELECT e.equipment_id, e.category, e.device_type, e.computer_name, e.device_model,
               e.manufacturer, e.equipment_code, e.service_tag,
               e.purchase_date, e.received_date, e.assigned_date,
               e.location, e.status,
               emp.full_name AS owner_name
        FROM dbo.equipment e
        LEFT JOIN dbo.employee emp ON e.owner_id = emp.employee_id
        WHERE COALESCE(e.received_date, e.purchase_date) BETWEEN @from AND @to
        ORDER BY COALESCE(e.received_date, e.purchase_date), e.equipment_id
      `);
    res.json({ from, to: to || from, count: result.recordset.length, equipment: result.recordset });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
