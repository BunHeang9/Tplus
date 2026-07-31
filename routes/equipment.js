const express = require('express');
const router = express.Router();
const { sql, poolPromise } = require('../config/db');
const { authenticate, requireAdmin } = require('../middleware/auth');

// GET /api/equipment
// List all equipment. Optional query params: ?category=Server  ?unowned=true
router.get('/', authenticate, async (req, res) => {
  // Supported filters (all optional, combinable):
  //   ?category=Server        exact category match
  //   ?unowned=true           only items with no owner
  //   ?location=VTE           exact device location
  //   ?department=TIT         exact device department
  //   ?status=Operational     exact status
  //   ?q=probook              free-text across model/hostname/code/tag/mac/ip
  const { category, unowned, location, department, status, q } = req.query;
  try {
    const pool = await poolPromise;
    let query = `
      SELECT e.*, emp.full_name AS owner_name
      FROM dbo.equipment e
      LEFT JOIN dbo.employee emp ON e.owner_id = emp.employee_id
      WHERE 1=1
    `;
    const request = pool.request();

    if (category) {
      query += ' AND e.category = @category';
      request.input('category', sql.VarChar, category);
    }
    if (unowned === 'true') {
      query += ' AND e.owner_id IS NULL';
    }
    if (location) {
      query += ' AND e.location = @location';
      request.input('location', sql.VarChar, location);
    }
    if (department) {
      query += ' AND e.department = @department';
      request.input('department', sql.VarChar, department);
    }
    if (status) {
      query += ' AND e.status = @status';
      request.input('status', sql.VarChar, status);
    }
    if (q) {
      query += ` AND (
        e.computer_name  LIKE @q OR
        e.device_model   LIKE @q OR
        e.equipment_code LIKE @q OR
        e.service_tag    LIKE @q OR
        e.mac_address    LIKE @q OR
        e.ip_address     LIKE @q OR
        e.manufacturer   LIKE @q OR
        emp.full_name    LIKE @q
      )`;
      request.input('q', sql.NVarChar, `%${q}%`);
    }
    query += ' ORDER BY e.category, e.equipment_id';

    const result = await request.query(query);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/equipment/categories
// Quick summary: count of items per category, and how many have no owner
router.get('/categories', authenticate, async (req, res) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request().query(`
      SELECT category,
             COUNT(*) AS total_items,
             SUM(CASE WHEN owner_id IS NULL THEN 1 ELSE 0 END) AS no_owner,
             SUM(CASE WHEN owner_id IS NOT NULL THEN 1 ELSE 0 END) AS has_owner
      FROM dbo.equipment
      GROUP BY category
      ORDER BY category
    `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/equipment/:id
router.get('/:id', authenticate, async (req, res) => {
  try {
    const pool = await poolPromise;
    const result = await pool
      .request()
      .input('id', sql.Int, req.params.id)
      .query(`
        SELECT e.*, emp.full_name AS owner_name
        FROM dbo.equipment e
        LEFT JOIN dbo.employee emp ON e.owner_id = emp.employee_id
        WHERE e.equipment_id = @id
      `);
    if (result.recordset.length === 0) {
      return res.status(404).json({ error: 'Equipment not found' });
    }
    res.json(result.recordset[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/equipment/:id/owner
// Reassign equipment to a different employee (or null it out to make it unowned/stock)
router.put('/:id/owner', authenticate, requireAdmin, async (req, res) => {
  const { owner_id } = req.body;
  try {
    const pool = await poolPromise;
    const result = await pool
      .request()
      .input('id', sql.Int, req.params.id)
      .input('owner_id', sql.Int, owner_id || null)
      .query(`
        UPDATE dbo.equipment
        SET owner_id = @owner_id
        OUTPUT INSERTED.*
        WHERE equipment_id = @id
      `);
    if (result.recordset.length === 0) {
      return res.status(404).json({ error: 'Equipment not found' });
    }
    res.json(result.recordset[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



module.exports = router;
