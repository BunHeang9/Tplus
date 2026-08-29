const sequelize = require('../config/sequelize');
const { QueryTypes } = require('sequelize');
const { RecycleBin, RecycleBinView } = require('./sequelize/recycleBinModel');

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
// must succeed or fail together with the delete it belongs to. Now that
// every caller has itself been migrated, that transaction is a Sequelize
// one (from sequelize.transaction()), not a raw sql.Transaction.
async function create({ entityType, entityId, entityLabel, entityData, actor, reason }, transaction) {
  const row = await RecycleBin.create({
    entity_type: entityType,
    entity_id: entityId,
    entity_label: entityLabel || null,
    entity_data: JSON.stringify(entityData),
    deleted_by_id: actor?.user_id || null,
    deleted_by: actor?.username || null,
    deleted_by_role: actor?.role || null,
    reason: reason || null,
  }, { transaction });

  return { bin_id: row.bin_id };
}

// Items still in the bin. Reads the view, which already excludes restored ones.
async function findAll(entityType) {
  return RecycleBinView.findAll({
    where: entityType ? { entity_type: entityType } : {},
    order: [['deleted_at', 'DESC']],
    raw: true,
  });
}

// Reads the base table rather than the view, so a restored item can still be
// looked up and entity_data is included.
async function findById(binId) {
  return RecycleBin.findByPk(binId, { raw: true });
}

// Checks whether the original id is free before attempting a restore.
async function idIsTaken(entityType, entityId) {
  const target = RESTORE_TARGETS[entityType];
  if (!target) return false;

  const rows = await sequelize.query(
    `SELECT 1 AS found FROM ${target.table} WHERE ${target.idColumn} = :id`,
    { replacements: { id: entityId }, type: QueryTypes.SELECT },
  );
  return rows.length > 0;
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
  const cols = await sequelize.query(`
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME = :table AND TABLE_SCHEMA = 'dbo'
    `, { replacements: { table: target.table.replace("dbo.", "") }, type: QueryTypes.SELECT });
  const liveColumns = new Set(cols.map((r) => r.COLUMN_NAME));

  const columns = Object.keys(data).filter(
    (c) => liveColumns.has(c) && data[c] !== undefined,
  );
  if (columns.length === 0) return { error: "no_columns", entry };

  // Self-contained now that this whole restore lives on one Sequelize
  // transaction - sequelize.transaction() rolls back automatically if the
  // callback throws, same guarantee the raw try/catch/rollback gave before.
  await sequelize.transaction(async (transaction) => {
    const columnList = columns.map((c) => `[${c}]`).join(", ");
    const valueList = columns.map((_, i) => `:p${i}`).join(", ");
    const replacements = {};
    columns.forEach((col, i) => { replacements[`p${i}`] = data[col]; });

    // SET IDENTITY_INSERT only lasts for the dynamic-SQL scope it was set
    // in - the driver runs each sequelize.query() call as its own batch, so
    // a SET issued in one call does not carry over into the next one even
    // on the same transaction/connection. It has to be set, used and
    // cleared inside this one single sequelize.query() call. TRY/CATCH
    // inside that one batch guarantees the OFF still runs if the INSERT
    // fails, since IDENTITY_INSERT is session state, not transactional - a
    // rollback would not undo it, and SQL Server allows it on only one
    // table per session, so leaving it on breaks the next restore that
    // reuses this pooled connection.
    await sequelize.query(`
      BEGIN TRY
        SET IDENTITY_INSERT ${target.table} ON;
        INSERT INTO ${target.table} (${columnList}) VALUES (${valueList});
        SET IDENTITY_INSERT ${target.table} OFF;
      END TRY
      BEGIN CATCH
        SET IDENTITY_INSERT ${target.table} OFF;
        THROW;
      END CATCH
    `, { replacements, transaction });

    await sequelize.query(`
        UPDATE dbo.recycle_bin
        SET restored_at = GETDATE(), restored_by = :restored_by
        WHERE bin_id = :id
      `, { replacements: { id: binId, restored_by: restoredBy || null }, transaction });
  });

  return { restored: data, entry };
}

// Permanent removal from the bin. There is no recovery after this.
// Sequelize's destroy() doesn't return the deleted row - fetch first so the
// caller still gets back what was removed.
async function purge(binId) {
  const row = await RecycleBin.findByPk(binId, { raw: true });
  if (!row) return null;
  await RecycleBin.destroy({ where: { bin_id: binId } });
  return row;
}

// Empties everything not yet restored, optionally limited to one entity type.
async function purgeAll(entityType) {
  const where = { restored_at: null };
  if (entityType) where.entity_type = entityType;
  return RecycleBin.destroy({ where });
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