const { DataTypes } = require('sequelize');
const sequelize = require('../../config/sequelize');

const Employee = sequelize.define('Employee', {
  employee_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  full_name: { type: DataTypes.STRING(150), allowNull: false },
  staff_code: { type: DataTypes.STRING(30), allowNull: true },
  phone: { type: DataTypes.STRING(30), allowNull: true },
  sex: { type: DataTypes.STRING(10), allowNull: true },
  location: { type: DataTypes.STRING(50), allowNull: true },
  position: { type: DataTypes.STRING(255), allowNull: true },
  department_id: { type: DataTypes.INTEGER, allowNull: true },
  // Has a DB-side default (1) - declared nullable here (not the real schema)
  // purely so create(), which never sets it, omits the column from the
  // INSERT and lets the DB default fill it in.
  is_active: { type: DataTypes.BOOLEAN, allowNull: true },
  left_date: { type: DataTypes.DATEONLY, allowNull: true },
}, {
  tableName: 'employee',
  schema: 'dbo',
  timestamps: false,
});

module.exports = Employee;
