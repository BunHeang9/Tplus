const { sql, poolPromise } = require('../config/db');

// Login accounts for the API itself (dbo.api_user) - separate from dbo.employee.

async function findByUsername(username) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('username', sql.VarChar, username)
    .query(`
      SELECT user_id, username, password_hash, full_name, role, is_active
      FROM dbo.api_user
      WHERE username = @username
    `);
  return result.recordset[0] || null;
}

async function create({ username, passwordHash, fullName, role, isActive }) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('username', sql.VarChar, username)
    .input('password_hash', sql.VarChar, passwordHash)
    .input('full_name', sql.NVarChar, fullName || null)
    .input('role', sql.VarChar, role || 'viewer')
    .input('is_active', sql.Bit, isActive === undefined ? 1 : isActive)
    .query(`
      INSERT INTO dbo.api_user (username, password_hash, full_name, role, is_active)
      OUTPUT INSERTED.user_id, INSERTED.username, INSERTED.full_name,
             INSERTED.role, INSERTED.is_active, INSERTED.created_at
      VALUES (@username, @password_hash, @full_name, @role, @is_active)
    `);
  return result.recordset[0];
}

async function findAll(includeInactive = true) {
  const pool = await poolPromise;
  let query = `
    SELECT user_id, username, full_name, role, is_active, created_at
    FROM dbo.api_user
  `;
  if (!includeInactive) query += ' WHERE is_active = 1';
  query += ' ORDER BY is_active DESC, created_at DESC';
  const result = await pool.request().query(query);
  return result.recordset;
}

async function findById(id) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('id', sql.Int, id)
    .query(`
      SELECT user_id, username, full_name, role, is_active, created_at
      FROM dbo.api_user WHERE user_id = @id
    `);
  return result.recordset[0] || null;
}

// Note: password_hash is deliberately never returned by findAll or findById.
async function update(id, { full_name, role, is_active }) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('id', sql.Int, id)
    .input('full_name', sql.NVarChar, full_name)
    .input('role', sql.VarChar, role)
    .input('is_active', sql.Bit, is_active)
    .query(`
      UPDATE dbo.api_user
      SET full_name = COALESCE(@full_name, full_name),
          role      = COALESCE(@role, role),
          is_active = COALESCE(@is_active, is_active)
      OUTPUT INSERTED.user_id, INSERTED.username, INSERTED.full_name,
             INSERTED.role, INSERTED.is_active, INSERTED.created_at
      WHERE user_id = @id
    `);
  return result.recordset[0] || null;
}

async function setPassword(id, passwordHash) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('id', sql.Int, id)
    .input('password_hash', sql.VarChar, passwordHash)
    .query(`
      UPDATE dbo.api_user
      SET password_hash = @password_hash
      OUTPUT INSERTED.user_id, INSERTED.username
      WHERE user_id = @id
    `);
  return result.recordset[0] || null;
}

async function countAdmins(excludeUserId) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('exclude', sql.Int, excludeUserId || 0)
    .query(`
      SELECT COUNT(*) AS admin_count
      FROM dbo.api_user
      WHERE role = 'admin' AND is_active = 1 AND user_id <> @exclude
    `);
  return result.recordset[0].admin_count;
}

module.exports = {
  findByUsername, create, findAll, findById, update, setPassword, countAdmins,
};
