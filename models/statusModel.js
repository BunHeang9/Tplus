const { sql, poolPromise } = require('../config/db');

// Reference table: dbo.equipment_status
//
// Returned to the frontend for dropdowns. The is_assignable / is_borrowable
// flags let the UI grey out impossible actions rather than duplicating the
// rules client-side.

async function findAll(activeOnly = true) {
  const pool = await poolPromise;
  let query = `
    SELECT s.status_id, s.status_name, s.description,
           s.has_owner, s.is_assignable, s.is_borrowable,
           s.sort_order, s.is_active,
           (SELECT COUNT(*) FROM dbo.equipment e WHERE e.status_id = s.status_id) AS equipment_count
    FROM dbo.equipment_status s
  `;
  if (activeOnly) query += ' WHERE s.is_active = 1';
  query += ' ORDER BY s.sort_order';

  const result = await pool.request().query(query);
  return result.recordset;
}

async function findById(id) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('id', sql.Int, id)
    .query('SELECT * FROM dbo.equipment_status WHERE status_id = @id');
  return result.recordset[0] || null;
}

async function findByName(name) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('name', sql.VarChar, name)
    .query('SELECT * FROM dbo.equipment_status WHERE status_name = @name');
  return result.recordset[0] || null;
}

module.exports = { findAll, findById, findByName };
