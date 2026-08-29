const { DataTypes } = require('sequelize');
const sequelize = require('../../config/sequelize');

// Base table - used for findById/create/purge/purgeAll. restore() stays raw
// SQL in models/recycleBinModel.js (see the comments there for why - dynamic
// IDENTITY_INSERT across arbitrary tables).
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

module.exports = { RecycleBin, RecycleBinView };
