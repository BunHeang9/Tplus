const { DataTypes } = require('sequelize');
const sequelize = require('../config/sequelize');

// Deleted records held for admin review.
//
// The whole row is captured as JSON and the original removed, rather than
// flagging rows deleted in place. A soft-delete flag would mean every query
// in the project needs WHERE is_deleted = 0, and missing one anywhere
// silently resurfaces deleted records in a dropdown or a count.
//
// Base table - used for findById/create/purge/purgeAll. restore() stays raw
// SQL below (see the comments there for why - dynamic IDENTITY_INSERT
// across arbitrary tables).
const RecycleBin = sequelize.define('RecycleBin', {
  bin_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  entity_type: { type: DataTypes.STRING, allowNull: false },
  entity_id: { type: DataTypes.INTEGER, allowNull: false },
  entity_label: { type: DataTypes.STRING, allowNull: true },
  entity_data: { type: DataTypes.TEXT, allowNull: false },
  deleted_by_id: { type: DataTypes.INTEGER, allowNull: true },
  deleted_by: { type: DataTypes.STRING, allowNull: true },
  deleted_by_role: { type: DataTypes.STRING, allowNull: true },
  // Legacy DATETIME with its own DB-side default - declared nullable here
  // (not the real schema) so create() omits the column and lets the DB
  // default fill it in, same pattern as every other created_at/deleted_at
  // column in this migration.
  deleted_at: { type: DataTypes.DATE, allowNull: true },
  restored_at: { type: DataTypes.DATE, allowNull: true },
  restored_by: { type: DataTypes.STRING, allowNull: true },
  reason: { type: DataTypes.STRING, allowNull: true },
}, {
  tableName: 'recycle_bin',
  schema: 'dbo',
  timestamps: false,
});

// The view - excludes already-restored rows and adds days_in_bin. Read-only
// by nature (nothing here ever writes to a view).
const RecycleBinView = sequelize.define('RecycleBinView', {
  bin_id: { type: DataTypes.INTEGER, primaryKey: true },
  entity_type: { type: DataTypes.STRING, allowNull: false },
  entity_id: { type: DataTypes.INTEGER, allowNull: false },
  entity_label: { type: DataTypes.STRING, allowNull: true },
  deleted_by: { type: DataTypes.STRING, allowNull: true },
  deleted_by_role: { type: DataTypes.STRING, allowNull: true },
  deleted_at: { type: DataTypes.DATE, allowNull: false },
  reason: { type: DataTypes.STRING, allowNull: true },
  days_in_bin: { type: DataTypes.INTEGER, allowNull: true },
}, {
  tableName: 'vw_recycle_bin',
  schema: 'dbo',
  timestamps: false,
});

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

// Which Sequelize model owns each restorable entity_type - lazily required
// (this whole file's own required-by graph is a mix: employeeModel.js
// requires this file eagerly at its own top level, so this file's require
// of Employee back must be lazy; department/equipment/category don't
// require this file eagerly at all, but the same lazy pattern is used for
// all four here for consistency, verified in both load orders).
function resolveModel(entityType) {
  switch (entityType) {
    case 'employee': return require('./employeeModel').Employee;
    case 'equipment': return require('./equipmentModel').Equipment;
    case 'department': return require('./departmentModel').Department;
    case 'category': return require('./categoryModel').Category;
    default: return null;
  }
}

// Checks whether the original id is free before attempting a restore.
async function idIsTaken(entityType, entityId) {
  const target = RESTORE_TARGETS[entityType];
  const Model = resolveModel(entityType);
  if (!target || !Model) return false;

  const count = await Model.count({ where: { [target.idColumn]: entityId } });
  return count > 0;
}

// Puts the row back with its original primary key.
//
// Preserving the id matters: borrow_record and others may still
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
  // delete would otherwise make the INSERT fail. No Sequelize model maps
  // onto "every column of an arbitrary table", so this uses Sequelize's own
  // QueryInterface.describeTable() - the ORM-level introspection API,
  // same technique as viewColumnModel.js/partStockColumnModel.js/
  // partModel.js's uses of it elsewhere in this migration.
  const desc = await sequelize.getQueryInterface().describeTable({
    tableName: target.table.replace("dbo.", ""), schema: 'dbo',
  });
  const liveColumns = new Set(Object.keys(desc));

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

    await RecycleBin.update(
      { restored_at: sequelize.fn('GETDATE'), restored_by: restoredBy || null },
      { where: { bin_id: binId }, transaction },
    );
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
  idIsTaken,
  restore,
  purge,
  purgeAll,
};