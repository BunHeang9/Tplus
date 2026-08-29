const { DataTypes } = require('sequelize');
const sequelize = require('../../config/sequelize');

const AuditLog = sequelize.define('AuditLog', {
  audit_id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
  actor_user_id: { type: DataTypes.INTEGER, allowNull: true },
  actor_username: { type: DataTypes.STRING(255), allowNull: false },
  actor_name: { type: DataTypes.STRING(255), allowNull: true },
  actor_role: { type: DataTypes.STRING(50), allowNull: false },
  action: { type: DataTypes.STRING(20), allowNull: false },
  entity_type: { type: DataTypes.STRING(50), allowNull: false },
  entity_id: { type: DataTypes.STRING(100), allowNull: true },
  request_path: { type: DataTypes.STRING(500), allowNull: false },
  change_data: { type: DataTypes.TEXT, allowNull: true },
  // Has its own DB-side default (DF_audit_log_created_at), same as the
  // original raw INSERT relied on (it never set this column either).
  // allowNull: true is not the real schema - it only stops Sequelize
  // validating a value into existence client-side. With no defaultValue
  // and nothing passed to create(), Sequelize omits the column from the
  // INSERT and the DB default fills it in, using the DB server's own
  // clock rather than Sequelize's generated timestamp.
  created_at: { type: DataTypes.DATE, allowNull: true },
}, {
  tableName: 'audit_log',
  schema: 'dbo',
  timestamps: false,
});

module.exports = AuditLog;
