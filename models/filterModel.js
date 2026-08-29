const sequelize = require('../config/sequelize');
const { QueryTypes } = require('sequelize');

// Distinct values for building dropdown filters on the frontend,
// read live from the data so new values appear automatically.
//
// Nine independent single-purpose lookups across four tables, none of them
// writes - raw queries through Sequelize rather than ORM models, same
// reasoning as deviceReplacementModel: Equipment/Department/EquipmentStatus/
// Employee get real Sequelize models when their own owning files
// (equipmentModel, departmentModel, statusModel, employeeModel) are
// migrated, not designed early just to serve a handful of dropdown lists
// here.
async function getAllFilterOptions() {
  const q = (sql) => sequelize.query(sql, { type: QueryTypes.SELECT });

  const [categories, deviceTypes, locations, departments, statuses,
         manufacturers, empDepartments, empLocations, empPositions] = await Promise.all([
    q('SELECT category_id, category_name FROM dbo.category WHERE is_active = 1 ORDER BY category_name'),
    q('SELECT DISTINCT device_type FROM dbo.equipment WHERE device_type IS NOT NULL ORDER BY device_type'),
    q('SELECT DISTINCT location FROM dbo.equipment WHERE location IS NOT NULL ORDER BY location'),
    q('SELECT department_id, department_code, department_name FROM dbo.department WHERE is_active = 1 ORDER BY department_code'),
    q(`SELECT status_id, status_name, description, is_assignable, is_borrowable
       FROM dbo.equipment_status WHERE is_active = 1 ORDER BY sort_order`),
    q('SELECT DISTINCT manufacturer FROM dbo.equipment WHERE manufacturer IS NOT NULL ORDER BY manufacturer'),
    q('SELECT department_id, department_code, department_name FROM dbo.department WHERE is_active = 1 ORDER BY department_code'),
    q('SELECT DISTINCT location FROM dbo.employee WHERE location IS NOT NULL ORDER BY location'),
    q('SELECT DISTINCT position FROM dbo.employee WHERE position IS NOT NULL ORDER BY position'),
  ]);

  return {
    equipment: {
      // Now objects rather than plain strings, so the frontend can send
      // back the id while still showing the name in the dropdown.
      categories,
      device_types:  deviceTypes.map(r => r.device_type),
      locations:     locations.map(r => r.location),
      departments,
      // From the reference table, so every valid option appears in the
      // dropdown even when no equipment currently has that status.
      statuses,
      manufacturers: manufacturers.map(r => r.manufacturer),
    },
    employee: {
      departments: empDepartments,
      locations:   empLocations.map(r => r.location),
      positions:   empPositions.map(r => r.position),
    },
  };
}

// Everything the assign page needs on load, in one call rather than four -
// deliberately separate from getAllFilterOptions() above: these carry counts
// (how many people hold each position, how many of each category are still
// available) that a generic filter dropdown has no use for, and locations
// here means unowned equipment locations only, not every device's. Moved
// here from assignController.js, which used to run these queries itself.
async function getAssignFormData() {
  const q = (sql) => sequelize.query(sql, { type: QueryTypes.SELECT });

  const [positions, statuses, categories, locations] = await Promise.all([
    q(`SELECT position, COUNT(*) AS employee_count
       FROM dbo.employee
       WHERE position IS NOT NULL AND LTRIM(RTRIM(position)) <> '' AND is_active = 1
       GROUP BY position ORDER BY position`),
    q(`SELECT status_id, status_name, description, is_assignable
       FROM dbo.equipment_status
       WHERE is_active = 1 ORDER BY sort_order`),
    q(`SELECT c.category_id, c.category_name,
              (SELECT COUNT(*) FROM dbo.equipment e
                WHERE e.category_id = c.category_id AND e.owner_id IS NULL) AS available_count
       FROM dbo.category c WHERE c.is_active = 1 ORDER BY c.category_name`),
    q(`SELECT DISTINCT location FROM dbo.equipment
       WHERE location IS NOT NULL AND owner_id IS NULL ORDER BY location`),
  ]);

  return {
    positions,
    statuses,
    categories,
    locations: locations.map((r) => r.location),
  };
}

module.exports = { getAllFilterOptions, getAssignFormData };
