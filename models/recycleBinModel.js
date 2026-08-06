const { sql, poolPromise } = require('../config/db');

// Deleted records held for admin review.
//
// The whole row is captured as JSON and the original removed, rather than
// flagging rows deleted in place. A soft-delete flag would mean every query
// in the project needs WHERE is_deleted = 0, and missing one anywhere
// silently resurfaces deleted records in a dropdown or a count.
//
// Which table each entity_type restores into. Kept here so restore stays
// generic - adding a new deletable entity means one line, not a new function.
const RESTORE_TARGETS = {
  employee:   { table: 'dbo.employee',   idColumn: 'employee_id' },
  equipment:  { table: 'dbo.equipment',  idColumn: 'equipment_id' },
  department: { table: 'dbo.department', idColumn: 'department_id' },
  category:   { table: 'dbo.category',   idColumn: 'category_id' },
};

// Pass a transaction when the caller already has one open - the bin write
// must succeed or fail together with the delete it belongs to.
async function create({ entityType, entityId, entityLabel, entityData, actor, reason }, transaction) {
  const request = transaction
    ? new sql.Request(transaction)
    : (await poolPromise).request();

  request
    .input('entity_type', sql.VarChar, entityType)
    .input('entity_id', sql.Int, entityId)
    .input('entity_label', sql.NVarChar, entityLabel || null)
    .input('entity_data', sql.NVarChar(sql.MAX), JSON.stringify(entityData))
    .input('deleted_by_id', sql.Int, actor?.user_id || null)
    .input('deleted_by', sql.NVarChar, actor?.username || null)
    .input('deleted_by_role', sql.VarChar, actor?.role || null)
    .input('reason', sql.NVarChar, reason || null);

  const result = await request.query(`
    INSERT INTO dbo.recycle_bin (
      entity_type, entity_id, entity_label, entity_data,
      deleted_by_id, deleted_by, deleted_by_role, reason
    )
    OUTPUT INSERTED.bin_id
    VALUES (
      @entity_type, @entity_id, @entity_label, @entity_data,
      @deleted_by_id, @deleted_by, @deleted_by_role, @reason
    )
  `);

  return result.recordset[0];
}

// Items still in the bin. Reads the view, which already excludes restored ones.
async function findAll(entityType) {
  const pool = await poolPromise;
  const request = pool.request();

  let query = 'SELECT * FROM dbo.vw_recycle_bin';
  if (entityType) {
    query += ' WHERE entity_type = @entity_type';
    request.input('entity_type', sql.VarChar, entityType);
  }
  query += ' ORDER BY deleted_at DESC';

  const result = await request.query(query);
  return result.recordset;
}

// Reads the base table rather than the view, so a restored item can still be
// looked up and entity_data is included.
async function findById(binId) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('id', sql.Int, binId)
    .query('SELECT * FROM dbo.recycle_bin WHERE bin_id = @id');
  return result.recordset[0] || null;
}

// Checks whether the original id is free before attempting a restore.
async function idIsTaken(entityType, entityId) {
  const target = RESTORE_TARGETS[entityType];
  if (!target) return false;

  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('id', sql.Int, entityId)
    .query(`SELECT 1 AS found FROM ${target.table} WHERE ${target.idColumn} = @id`);
  return result.recordset.length > 0;
}

// Puts the row back with its original primary key.
//
// Preserving the id matters: borrow_record, ssd_upgrade and others may still
// reference it, and letting IDENTITY assign a new one would leave those
// pointing at nothing. That requires IDENTITY_INSERT, which SQL Server only
// allows on one table at a time - hence turning it off again in the same
// transaction, including on the error path.
async function restore(binId, restoredBy) {
  const entry = await findById(binId);
  if (!entry) return { error: "not_found" };
  if (entry.restored_at) return { error: "already_restored", entry };

  const target = RESTORE_TARGETS[entry.entity_type];
  if (!target) return { error: "unknown_type", entry };

  const taken = await idIsTaken(entry.entity_type, entry.entity_id);
  if (taken) return { error: "id_taken", entry };

  const data = JSON.parse(entry.entity_data);

  // Only restore columns the table still has - a column dropped since the
  // delete would otherwise make the INSERT fail.
  const pool = await poolPromise;
  const cols = await pool
    .request()
    .input("table", sql.VarChar, target.table.replace("dbo.", "")).query(`
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME = @table AND TABLE_SCHEMA = 'dbo'
    `);
  const liveColumns = new Set(cols.recordset.map((r) => r.COLUMN_NAME));

  const columns = Object.keys(data).filter(
    (c) => liveColumns.has(c) && data[c] !== undefined,
  );
  if (columns.length === 0) return { error: "no_columns", entry };

  const transaction = new sql.Transaction(pool);
  await transaction.begin();

  // Once SQL Server aborts a transaction, calling rollback() on it throws a
  // second error that masks the first. Track state so the real cause survives.
  let aborted = false;

  try {
    const columnList = columns.map((c) => `[${c}]`).join(", ");
    const valueList = columns.map((_, i) => `@p${i}`).join(", ");

    // IDENTITY_INSERT is session state, so it has to be set, used and cleared
    // as separate statements on the same transaction. Batching all three into
    // one query() lets the driver run them out of context and the INSERT then
    // fails for writing an explicit identity value.
    await new sql.Request(transaction).query(
      `SET IDENTITY_INSERT ${target.table} ON`,
    );

    try {
      const insertRequest = new sql.Request(transaction);
      columns.forEach((col, i) => {
        insertRequest.input(`p${i}`, data[col]);
      });

      await insertRequest.query(
        `INSERT INTO ${target.table} (${columnList}) VALUES (${valueList})`,
      );
    } finally {
      // Clear it even if the insert failed - SQL Server permits IDENTITY_INSERT
      // on only one table per session, so leaving it on breaks the next restore.
      try {
        await new sql.Request(transaction).query(
          `SET IDENTITY_INSERT ${target.table} OFF`,
        );
      } catch {
        aborted = true; // transaction already dead; nothing to clean up
      }
    }

    await new sql.Request(transaction)
      .input("id", sql.Int, binId)
      .input("restored_by", sql.NVarChar, restoredBy || null).query(`
        UPDATE dbo.recycle_bin
        SET restored_at = GETDATE(), restored_by = @restored_by
        WHERE bin_id = @id
      `);

    await transaction.commit();
    return { restored: data, entry };
  } catch (err) {
    if (!aborted) {
      try {
        await transaction.rollback();
      } catch {
        // Already rolled back by SQL Server - keep the original error.
      }
    }
    throw err;
  }
}

// Permanent removal from the bin. There is no recovery after this.
async function purge(binId) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('id', sql.Int, binId)
    .query('DELETE FROM dbo.recycle_bin OUTPUT DELETED.* WHERE bin_id = @id');
  return result.recordset[0] || null;
}

// Empties everything not yet restored, optionally limited to one entity type.
async function purgeAll(entityType) {
  const pool = await poolPromise;
  const request = pool.request();

  let query = 'DELETE FROM dbo.recycle_bin OUTPUT DELETED.bin_id WHERE restored_at IS NULL';
  if (entityType) {
    query += ' AND entity_type = @entity_type';
    request.input('entity_type', sql.VarChar, entityType);
  }

  const result = await request.query(query);
  return result.recordset.length;
}

module.exports = {
  RESTORE_TARGETS,
  create,
  findAll,
  findById,
  restore,
  purge,
  purgeAll,
};