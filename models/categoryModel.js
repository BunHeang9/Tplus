const { sql, poolPromise } = require('../config/db');

// Reference table: dbo.category (Laptop, Desktop, PC, Server, Monitor, CCTV, ...)

async function findAll() {
  const pool = await poolPromise;
  const result = await pool.request().query(`
    SELECT c.category_id, c.category_name, c.description, c.is_active,
           (SELECT COUNT(*) FROM dbo.equipment e WHERE e.category_id = c.category_id) AS equipment_count
    FROM dbo.category c
    ORDER BY c.category_name
  `);
  return result.recordset;
}

async function findById(id) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('id', sql.Int, id)
    .query('SELECT * FROM dbo.category WHERE category_id = @id');
  return result.recordset[0] || null;
}

async function findByName(name) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('name', sql.VarChar, name)
    .query('SELECT * FROM dbo.category WHERE category_name = @name');
  return result.recordset[0] || null;
}

async function create({ category_name, description }) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input("name", sql.VarChar, category_name)
    .input("description", sql.NVarChar, description || null).query(`
      INSERT INTO dbo.category (category_name, description, view_key)
      OUTPUT INSERTED.*
      VALUES (
        @name, @description,
        -- Generated from the name so /api/equipment/network-device works.
        -- Without this a new category has no reachable view.
        LOWER(REPLACE(REPLACE(@name, ' ', '-'), '_', '-'))
      )
    `);
  return result.recordset[0];
}

async function update(id, { category_name, description, is_active }) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input("id", sql.Int, id)
    .input("name", sql.VarChar, category_name)
    .input("description", sql.NVarChar, description)
    .input("is_active", sql.Bit, is_active).query(`
      UPDATE dbo.category
      SET category_name = COALESCE(@name, category_name),
          description   = COALESCE(@description, description),
          is_active     = COALESCE(@is_active, is_active),
          -- Regenerated on rename so the URL keeps matching the name -
          -- otherwise a category renamed to "Testing" would still be served
          -- at /api/equipment/test. Only changes when the name does.
          view_key      = CASE
                            WHEN @name IS NOT NULL
                            THEN LOWER(REPLACE(REPLACE(@name, ' ', '-'), '_', '-'))
                            ELSE view_key
                          END
      OUTPUT INSERTED.*
      WHERE category_id = @id
    `);
  return result.recordset[0] || null;
}

async function countUsage(id) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('id', sql.Int, id)
    .query('SELECT COUNT(*) AS equipment_count FROM dbo.equipment WHERE category_id = @id');
  return result.recordset[0];
}

async function remove(id) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('id', sql.Int, id)
    .query('DELETE FROM dbo.category OUTPUT DELETED.* WHERE category_id = @id');
  return result.recordset[0] || null;
}

module.exports = { findAll, findById, findByName, create, update, countUsage, remove };
