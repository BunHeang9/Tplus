const express = require('express');
const router = express.Router();
const { sql, poolPromise } = require('../config/db');
const { authenticate } = require('../middleware/auth');

// GET /api/search?q=<anything>
//
// Universal search. Matches the term against employees AND equipment across
// many fields (name, hostname, asset code, service tag, MAC, IP, model,
// manufacturer, department, location, position...).
//
// Returns a single flat array so the frontend can render one results table.
// Each row has a "match_type" field ('Employee' or 'Equipment') so the UI can
// group or badge them differently if wanted.
router.get('/', authenticate, async (req, res) => {
  const term = req.query.q;

  if (!term || term.trim() === '') {
    return res.status(400).json({ error: 'Query parameter "q" is required, e.g. /api/search?q=Fongmoua' });
  }

  try {
    const pool = await poolPromise;
    const result = await pool
      .request()
      .input('term', sql.NVarChar, `%${term.trim()}%`)
      .query(`
        -- Equipment matches (joined to owner so the frontend always has a name to show)
        SELECT
          'Equipment' AS match_type,
          e.equipment_id,
          e.category,
          e.device_type,
          e.computer_name,
          e.device_model,
          e.manufacturer,
          e.equipment_code AS asset_code,
          e.service_tag,
          e.mac_address,
          e.ip_address,
          e.cpu, e.ram, e.hd,
          e.location AS device_location,
          e.department AS device_department,
          e.status AS device_status,
          e.remark,
          emp.employee_id,
          emp.full_name AS owner_name,
          emp.position AS owner_position,
          emp.department AS owner_department,
          emp.location AS owner_location
        FROM dbo.equipment e
        LEFT JOIN dbo.employee emp ON e.owner_id = emp.employee_id
        WHERE e.computer_name    LIKE @term
           OR e.device_model     LIKE @term
           OR e.equipment_code   LIKE @term
           OR e.service_tag      LIKE @term
           OR e.mac_address      LIKE @term
           OR e.ip_address       LIKE @term
           OR e.manufacturer     LIKE @term
           OR e.category         LIKE @term
           OR e.device_type      LIKE @term
           OR e.location         LIKE @term
           OR e.department       LIKE @term
           OR e.status           LIKE @term
           OR e.remark           LIKE @term
           OR e.cpu              LIKE @term
           OR emp.full_name      LIKE @term

        UNION ALL

        -- Employee matches that have no equipment (so people still show up in
        -- results even when they own nothing)
        SELECT
          'Employee' AS match_type,
          NULL AS equipment_id,
          NULL AS category,
          NULL AS device_type,
          NULL AS computer_name,
          NULL AS device_model,
          NULL AS manufacturer,
          NULL AS asset_code,
          NULL AS service_tag,
          NULL AS mac_address,
          NULL AS ip_address,
          NULL AS cpu, NULL AS ram, NULL AS hd,
          NULL AS device_location,
          NULL AS device_department,
          NULL AS device_status,
          NULL AS remark,
          emp.employee_id,
          emp.full_name AS owner_name,
          emp.position AS owner_position,
          emp.department AS owner_department,
          emp.location AS owner_location
        FROM dbo.employee emp
        WHERE (emp.full_name  LIKE @term
            OR emp.position   LIKE @term
            OR emp.department LIKE @term
            OR emp.location   LIKE @term
            OR emp.staff_code LIKE @term)
          AND NOT EXISTS (SELECT 1 FROM dbo.equipment eq WHERE eq.owner_id = emp.employee_id)

        ORDER BY match_type, owner_name, computer_name;
      `);

    res.json({
      query: term,
      count: result.recordset.length,
      results: result.recordset,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
