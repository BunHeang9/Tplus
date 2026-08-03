const { sql, poolPromise } = require('../config/db');

// All database access for employees lives here.
// Controllers call these functions; they never write SQL themselves.

// Active employees only by default - a leaver should not appear in an assign
// or borrow dropdown. Pass includeInactive to get everyone, e.g. for an admin
// screen or when resolving a name on an old record.
async function findAll(includeInactive = false) {
  const pool = await poolPromise;
  let query = `
    SELECT emp.employee_id, emp.full_name, emp.staff_code, emp.phone, emp.sex,
           emp.location, emp.position,
           emp.department_id,
           d.department_code,
           d.department_name,
           emp.is_active,
           emp.left_date
    FROM dbo.employee emp
    LEFT JOIN dbo.department d ON emp.department_id = d.department_id
  `;
  if (!includeInactive) query += ' WHERE emp.is_active = 1';
  query += ' ORDER BY emp.full_name';

  const result = await pool.request().query(query);
  return result.recordset;
}

async function findById(id) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('id', sql.Int, id)
    .query(`
      SELECT emp.*, d.department_code, d.department_name
      FROM dbo.employee emp
      LEFT JOIN dbo.department d ON emp.department_id = d.department_id
      WHERE emp.employee_id = @id
    `);
  return result.recordset[0] || null;
}

// The "search employee, see everything" query - joins equipment,
// server details and antivirus status into one flat result set.
async function searchWithEquipment(name) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('name', sql.NVarChar, `%${name}%`)
    .query(`
      SELECT
        emp.employee_id,
        emp.full_name AS owner_name,
        emp.position AS employee_position,
        emp.department_id AS employee_department_id,
        empd.department_code AS employee_department,
        empd.department_name AS employee_department_name,
        emp.location AS employee_location,
        emp.sex,
        emp.staff_code,
        emp.phone,
        e.equipment_id,
        e.category_id,
        c.category_name AS category,
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
        e.department_id AS device_department_id,
        eqd.department_code AS device_department,
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
      LEFT JOIN dbo.department empd ON emp.department_id = empd.department_id
      LEFT JOIN dbo.equipment e ON e.owner_id = emp.employee_id
      LEFT JOIN dbo.category c ON e.category_id = c.category_id
      LEFT JOIN dbo.department eqd ON e.department_id = eqd.department_id
      LEFT JOIN dbo.server_usage su ON su.equipment_id = e.equipment_id
      LEFT JOIN dbo.antivirus_install av ON av.equipment_id = e.equipment_id
      WHERE emp.full_name LIKE @name
      ORDER BY emp.full_name, c.category_name, e.computer_name
    `);
  return result.recordset;
}

async function findByName(fullName) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('full_name', sql.NVarChar, fullName)
    .query(`
      SELECT employee_id, full_name, department_id, location, position
      FROM dbo.employee WHERE full_name = @full_name
    `);
  return result.recordset[0] || null;
}

async function findReplacementHistory(employeeId) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('id', sql.Int, employeeId)
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
  return result.recordset;
}

async function create(data) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('full_name', sql.NVarChar, data.full_name)
    .input('staff_code', sql.VarChar, data.staff_code || null)
    .input('phone', sql.VarChar, data.phone || null)
    .input('sex', sql.VarChar, data.sex || null)
    .input('department_id', sql.Int, data.department_id || null)
    .input('location', sql.VarChar, data.location || null)
    .input('position', sql.NVarChar, data.position || null)
    .query(`
      INSERT INTO dbo.employee (full_name, staff_code, phone, sex, department_id, location, position)
      OUTPUT INSERTED.*
      VALUES (@full_name, @staff_code, @phone, @sex, @department_id, @location, @position)
    `);
  return result.recordset[0];
}

// Partial update - COALESCE keeps the existing value when a field isn't supplied.
async function update(id, data) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('id', sql.Int, id)
    .input('full_name', sql.NVarChar, data.full_name)
    .input('staff_code', sql.VarChar, data.staff_code)
    .input('phone', sql.VarChar, data.phone)
    .input('sex', sql.VarChar, data.sex)
    .input('department_id', sql.Int, data.department_id)
    .input('location', sql.VarChar, data.location)
    .input('position', sql.NVarChar, data.position)
    .input('is_active', sql.Bit, data.is_active)
    .input('left_date', sql.Date, data.left_date)
    .query(`
      UPDATE dbo.employee
      SET full_name     = COALESCE(@full_name, full_name),
          staff_code    = COALESCE(@staff_code, staff_code),
          phone         = COALESCE(@phone, phone),
          sex           = COALESCE(@sex, sex),
          department_id = COALESCE(@department_id, department_id),
          location      = COALESCE(@location, location),
          position      = COALESCE(@position, position),
          is_active     = COALESCE(@is_active, is_active),
          left_date     = COALESCE(@left_date, left_date)
      OUTPUT INSERTED.*
      WHERE employee_id = @id
    `);
  return result.recordset[0] || null;
}

// Everything referencing this employee. Delete is refused while any exist -
// removing a person would otherwise orphan their equipment and loan history.
async function countReferences(id) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('id', sql.Int, id)
    .query(`
      SELECT
        (SELECT COUNT(*) FROM dbo.equipment  WHERE owner_id = @id)   AS owned_equipment,
        (SELECT COUNT(*) FROM dbo.borrow_record WHERE borrower_id = @id
             OR issued_by_id = @id OR received_by_id = @id)          AS borrow_records,
        (SELECT COUNT(*) FROM dbo.borrow_record WHERE borrower_id = @id
             AND return_date IS NULL)                                AS items_still_out,
        (SELECT COUNT(*) FROM dbo.ssd_upgrade WHERE employee_id = @id) AS ssd_upgrades,
        (SELECT COUNT(*) FROM dbo.server_usage WHERE owner_id = @id)   AS server_usage,
        -- device_replacement only has employee_id; its issued_by_id and
        -- received_by_id columns were dropped as they were never populated.
        (SELECT COUNT(*) FROM dbo.device_replacement WHERE employee_id = @id) AS replacements
    `);
  return result.recordset[0];
}

async function remove(id, fullName) {
  const pool = await poolPromise;
  const transaction = new sql.Transaction(pool);
  const recycleBinModel = require("./recycleBinModel");
  await transaction.begin();

  try {
    const row = await new sql.Request(transaction)
      .input("id", sql.Int, id)
      .query("SELECT * full_name FROM dbo.employee WHERE employee_id = @id");
    await recycleBinModel.create(
      {
        entityType: "employee",
        entityId: id,
        entityLabel: row.recordset[0].full_name,
        entityData: JSON.stringify({
          employee_id: id,
          full_name: row.recordset[0].full_name,
        }),
        actor: "system", // You might want to replace this with the actual user performing the deletion
        reason: "Employee record deleted",
      },
      transaction,
    );
    // Snapshot the name and clear each reference before deletion. Doing this
    // explicitly avoids SQL Server's multiple-cascade-path restriction.
    await new sql.Request(transaction)
      .input("id", sql.Int, id)
      .input("full_name", sql.NVarChar, fullName).query(`
        UPDATE dbo.borrow_record
        SET borrower_name = CASE WHEN borrower_id = @id THEN COALESCE(borrower_name, @full_name) ELSE borrower_name END,
            issued_by_name = CASE WHEN issued_by_id = @id THEN COALESCE(issued_by_name, @full_name) ELSE issued_by_name END,
            received_by_name = CASE WHEN received_by_id = @id THEN COALESCE(received_by_name, @full_name) ELSE received_by_name END,
            borrower_id = CASE WHEN borrower_id = @id THEN NULL ELSE borrower_id END,
            issued_by_id = CASE WHEN issued_by_id = @id THEN NULL ELSE issued_by_id END,
            received_by_id = CASE WHEN received_by_id = @id THEN NULL ELSE received_by_id END
        WHERE borrower_id = @id OR issued_by_id = @id OR received_by_id = @id
      `);

    const result = await new sql.Request(transaction)
      .input("id", sql.Int, id)
      .query("DELETE FROM dbo.employee WHERE employee_id = @id");

    await transaction.commit();
    return (result.rowsAffected[0] || 0) > 0;
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

module.exports = {
  findAll,
  countReferences,
  remove,
  findById,
  findByName,
  searchWithEquipment,
  findReplacementHistory,
  create,
  update,
};
