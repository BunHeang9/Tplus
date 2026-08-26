const { sql, poolPromise } = require('../config/db');

// Reference table: dbo.department
// Departments used to be free text on employee/equipment; they now live
// here and are linked by department_id.

async function findAll() {
  const pool = await poolPromise;
  const result = await pool.request().query(`
    SELECT d.department_id, d.department_code, d.department_name, d.is_active,
           (SELECT COUNT(*) FROM dbo.employee  e WHERE e.department_id = d.department_id) AS employee_count,
           (SELECT COUNT(*) FROM dbo.equipment q WHERE q.department_id = d.department_id) AS equipment_count
    FROM dbo.department d
    ORDER BY d.department_code
  `);
  return result.recordset;
}

async function findById(id) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('id', sql.Int, id)
    .query('SELECT * FROM dbo.department WHERE department_id = @id');
  return result.recordset[0] || null;
}

async function findByCode(code) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('code', sql.VarChar, code)
    .query('SELECT * FROM dbo.department WHERE department_code = @code');
  return result.recordset[0] || null;
}

async function create({ department_code, department_name }) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('code', sql.VarChar, department_code)
    .input('name', sql.NVarChar, department_name || department_code)
    .query(`
      INSERT INTO dbo.department (department_code, department_name)
      OUTPUT INSERTED.*
      VALUES (@code, @name)
    `);
  return result.recordset[0];
}

async function update(id, { department_code, department_name, is_active }) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('id', sql.Int, id)
    .input('code', sql.VarChar, department_code)
    .input('name', sql.NVarChar, department_name)
    .input('is_active', sql.Bit, is_active)
    .query(`
      UPDATE dbo.department
      SET department_code = COALESCE(@code, department_code),
          department_name = COALESCE(@name, department_name),
          is_active       = COALESCE(@is_active, is_active)
      OUTPUT INSERTED.*
      WHERE department_id = @id
    `);
  return result.recordset[0] || null;
}

// Refuses to delete a department that is still referenced, so we never
// leave employees or equipment pointing at a row that no longer exists.
async function countUsage(id) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('id', sql.Int, id)
    .query(`
      SELECT
        (SELECT COUNT(*) FROM dbo.employee  WHERE department_id = @id) AS employee_count,
        (SELECT COUNT(*) FROM dbo.equipment WHERE department_id = @id) AS equipment_count
    `);
  return result.recordset[0];
}

// Captures the row into the recycle bin before removing it, both in one
// transaction - so a failed delete cannot leave an orphaned bin entry, and a
// failed bin write cannot lose the department. Mirrors equipmentModel.remove
// one level down; no dependent rows to clean up here since the controller
// already refuses to delete a department still referenced by an employee or
// piece of equipment.
async function remove(id, actor) {
  const recycleBinModel = require('./recycleBinModel');

  const pool = await poolPromise;
  const transaction = new sql.Transaction(pool);
  await transaction.begin();

  try {
    const row = await new sql.Request(transaction)
      .input('id', sql.Int, id)
      .query('SELECT * FROM dbo.department WHERE department_id = @id');

    const department = row.recordset[0];
    if (!department) {
      await transaction.rollback();
      return null;
    }

    await recycleBinModel.create(
      {
        entityType: 'department',
        entityId: id,
        entityLabel: department.department_name || department.department_code,
        entityData: department,
        actor,
        reason: 'Department deleted',
      },
      transaction,
    );

    await new sql.Request(transaction)
      .input('id', sql.Int, id)
      .query('DELETE FROM dbo.department WHERE department_id = @id');

    await transaction.commit();
    return department;
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

module.exports = { findAll, findById, findByCode, create, update, countUsage, remove };
