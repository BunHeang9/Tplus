const { DataTypes } = require('sequelize');
const sequelize = require('../../config/sequelize');

const ApiUser = sequelize.define('ApiUser', {
  user_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  username: { type: DataTypes.STRING(50), allowNull: false },
  password_hash: { type: DataTypes.STRING(255), allowNull: false },
  full_name: { type: DataTypes.STRING(150), allowNull: true },
  role: { type: DataTypes.STRING(20), allowNull: false },
  is_active: { type: DataTypes.BOOLEAN, allowNull: false },
  // Has its own DB-side default (legacy DATETIME, same treatment as
  // categoryModel/auditLogModel: let the DB default handle it rather than
  // have Sequelize generate an incompatible timestamp format).
  created_at: { type: DataTypes.DATE, allowNull: true },
}, {
  tableName: 'api_user',
  schema: 'dbo',
  timestamps: false,
});

module.exports = ApiUser;
