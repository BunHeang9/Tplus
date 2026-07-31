const { poolPromise } = require('../config/db');

// Distinct values for building dropdown filters on the frontend,
// read live from the data so new values appear automatically.
async function getAllFilterOptions() {
  const pool = await poolPromise;

  const [categories, deviceTypes, locations, departments, statuses,
         manufacturers, empDepartments, empLocations, empPositions] = await Promise.all([
    pool.request().query('SELECT category_id, category_name FROM dbo.category WHERE is_active = 1 ORDER BY category_name'),
    pool.request().query('SELECT DISTINCT device_type FROM dbo.equipment WHERE device_type IS NOT NULL ORDER BY device_type'),
    pool.request().query('SELECT DISTINCT location FROM dbo.equipment WHERE location IS NOT NULL ORDER BY location'),
    pool.request().query('SELECT department_id, department_code, department_name FROM dbo.department WHERE is_active = 1 ORDER BY department_code'),
    pool.request().query(`SELECT status_id, status_name, description, is_assignable, is_borrowable
                          FROM dbo.equipment_status WHERE is_active = 1 ORDER BY sort_order`),
    pool.request().query('SELECT DISTINCT manufacturer FROM dbo.equipment WHERE manufacturer IS NOT NULL ORDER BY manufacturer'),
    pool.request().query('SELECT department_id, department_code, department_name FROM dbo.department WHERE is_active = 1 ORDER BY department_code'),
    pool.request().query('SELECT DISTINCT location FROM dbo.employee WHERE location IS NOT NULL ORDER BY location'),
    pool.request().query('SELECT DISTINCT position FROM dbo.employee WHERE position IS NOT NULL ORDER BY position'),
  ]);

  return {
    equipment: {
      // Now objects rather than plain strings, so the frontend can send
      // back the id while still showing the name in the dropdown.
      categories:    categories.recordset,
      device_types:  deviceTypes.recordset.map(r => r.device_type),
      locations:     locations.recordset.map(r => r.location),
      departments:   departments.recordset,
      // From the reference table, so every valid option appears in the
      // dropdown even when no equipment currently has that status.
      statuses:      statuses.recordset,
      manufacturers: manufacturers.recordset.map(r => r.manufacturer),
    },
    employee: {
      departments: empDepartments.recordset,
      locations:   empLocations.recordset.map(r => r.location),
      positions:   empPositions.recordset.map(r => r.position),
    },
  };
}

module.exports = { getAllFilterOptions };
