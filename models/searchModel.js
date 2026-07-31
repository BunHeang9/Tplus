const { sql, poolPromise } = require('../config/db');

// Universal search across employees AND equipment.
// Returns one flat array so the frontend can render a single results table;
// each row carries a match_type so the UI can badge them differently.
async function searchAll(term) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('term', sql.NVarChar, `%${term.trim()}%`)
    .query(`
      SELECT
        'Equipment' AS match_type,
        e.equipment_id,
        c.category_name AS category,
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
        eqd.department_code AS device_department,
        e.status AS device_status,
        e.remark,
        emp.employee_id,
        emp.full_name AS owner_name,
        emp.position AS owner_position,
        empd.department_code AS owner_department,
        emp.location AS owner_location
      FROM dbo.equipment e
      LEFT JOIN dbo.category c ON e.category_id = c.category_id
      LEFT JOIN dbo.department eqd ON e.department_id = eqd.department_id
      LEFT JOIN dbo.employee emp ON e.owner_id = emp.employee_id
      LEFT JOIN dbo.department empd ON emp.department_id = empd.department_id
      WHERE e.computer_name    LIKE @term
         OR e.device_model     LIKE @term
         OR e.equipment_code   LIKE @term
         OR e.service_tag      LIKE @term
         OR e.mac_address      LIKE @term
         OR e.ip_address       LIKE @term
         OR e.manufacturer     LIKE @term
         OR c.category_name    LIKE @term
         OR e.device_type      LIKE @term
         OR e.location         LIKE @term
         OR eqd.department_code LIKE @term
         OR e.status           LIKE @term
         OR e.remark           LIKE @term
         OR e.cpu              LIKE @term
         OR emp.full_name      LIKE @term

      UNION ALL

      -- Employees who own nothing still need to appear in results
      SELECT
        'Employee' AS match_type,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        emp.employee_id,
        emp.full_name AS owner_name,
        emp.position AS owner_position,
        empd2.department_code AS owner_department,
        emp.location AS owner_location
      FROM dbo.employee emp
      LEFT JOIN dbo.department empd2 ON emp.department_id = empd2.department_id
      WHERE (emp.full_name        LIKE @term
          OR emp.position         LIKE @term
          OR empd2.department_code LIKE @term
          OR emp.location         LIKE @term
          OR emp.staff_code       LIKE @term)
        AND NOT EXISTS (SELECT 1 FROM dbo.equipment eq WHERE eq.owner_id = emp.employee_id)

      ORDER BY match_type, owner_name, computer_name;
    `);
  return result.recordset;
}

module.exports = { searchAll };
