const express = require('express');
const router = express.Router();
const { poolPromise } = require('../config/db');
const { authenticate } = require('../middleware/auth');

// GET /api/filters
//
// Returns every distinct value the frontend can offer as a dropdown filter.
// Lets the UI build category/location/department/status pickers without
// hardcoding values that might change as data is added.
router.get('/', authenticate, async (req, res) => {
  try {
    const pool = await poolPromise;

    const [categories, deviceTypes, locations, departments, statuses,
           manufacturers, empDepartments, empLocations, empPositions] = await Promise.all([
      pool.request().query("SELECT DISTINCT category FROM dbo.equipment WHERE category IS NOT NULL ORDER BY category"),
      pool.request().query("SELECT DISTINCT device_type FROM dbo.equipment WHERE device_type IS NOT NULL ORDER BY device_type"),
      pool.request().query("SELECT DISTINCT location FROM dbo.equipment WHERE location IS NOT NULL ORDER BY location"),
      pool.request().query("SELECT DISTINCT department FROM dbo.equipment WHERE department IS NOT NULL ORDER BY department"),
      pool.request().query("SELECT DISTINCT status FROM dbo.equipment WHERE status IS NOT NULL ORDER BY status"),
      pool.request().query("SELECT DISTINCT manufacturer FROM dbo.equipment WHERE manufacturer IS NOT NULL ORDER BY manufacturer"),
      pool.request().query("SELECT DISTINCT department FROM dbo.employee WHERE department IS NOT NULL ORDER BY department"),
      pool.request().query("SELECT DISTINCT location FROM dbo.employee WHERE location IS NOT NULL ORDER BY location"),
      pool.request().query("SELECT DISTINCT position FROM dbo.employee WHERE position IS NOT NULL ORDER BY position"),
    ]);

    res.json({
      equipment: {
        categories:    categories.recordset.map(r => r.category),
        device_types:  deviceTypes.recordset.map(r => r.device_type),
        locations:     locations.recordset.map(r => r.location),
        departments:   departments.recordset.map(r => r.department),
        statuses:      statuses.recordset.map(r => r.status),
        manufacturers: manufacturers.recordset.map(r => r.manufacturer),
      },
      employee: {
        departments: empDepartments.recordset.map(r => r.department),
        locations:   empLocations.recordset.map(r => r.location),
        positions:   empPositions.recordset.map(r => r.position),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
