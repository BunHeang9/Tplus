const { DataTypes } = require('sequelize');
const sequelize = require('../../config/sequelize');

const Department = sequelize.define('Department', {
  department_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  department_code: { type: DataTypes.STRING(50), allowNull: false },
  department_name: { type: DataTypes.STRING(100), allowNull: true },
  is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  // Has its own DB-side default (legacy DATETIME) - let the DB fill it in,
  // same reasoning as categoryModel/auditLogModel/apiUserModel.
  created_at: { type: DataTypes.DATE, allowNull: true },
}, {
  tableName: 'department',
  schema: 'dbo',
  timestamps: false,
});

module.exports = Department;
