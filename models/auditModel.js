const { sql, poolPromise } = require('../config/db');

async function create(entry) {
  const pool = await poolPromise;
  await pool.request()
    .input('actor_user_id', sql.Int, entry.actor.user_id)
    .input('actor_username', sql.NVarChar, entry.actor.username)
    .input('actor_name', sql.NVarChar, entry.actor.full_name || null)
    .input('actor_role', sql.VarChar, entry.actor.role)
    .input('action', sql.VarChar, entry.action)
    .input('entity_type', sql.VarChar, entry.entityType)
    .input('entity_id', sql.NVarChar, entry.entityId || null)
    .input('request_path', sql.NVarChar, entry.requestPath)
    .input('change_data', sql.NVarChar(sql.MAX), JSON.stringify(entry.changeData || {}))
    .query(`
      INSERT INTO dbo.audit_log (
        actor_user_id, actor_username, actor_name, actor_role,
        action, entity_type, entity_id, request_path, change_data
      ) VALUES (
        @actor_user_id, @actor_username, @actor_name, @actor_role,
        @action, @entity_type, @entity_id, @request_path, @change_data
      )
    `);
}

async function findAll(limit = 200) {
  const pool = await poolPromise;
  const result = await pool.request()
    .input('limit', sql.Int, limit)
    .query(`
      SELECT TOP (@limit) audit_id, actor_user_id, actor_username, actor_name,
             actor_role, action, entity_type, entity_id, request_path,
             change_data, created_at
      FROM dbo.audit_log
      ORDER BY created_at DESC, audit_id DESC
    `);
  return result.recordset;
}

module.exports = { create, findAll };
