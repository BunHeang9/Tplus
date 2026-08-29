const { DataTypes } = require('sequelize');
const sequelize = require('../../config/sequelize');

const AntivirusInstall = sequelize.define('AntivirusInstall', {
  install_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  equipment_id: { type: DataTypes.INTEGER, allowNull: false },
  antivirus_status: { type: DataTypes.STRING(30), allowNull: true },
  windows_server_license: { type: DataTypes.BOOLEAN, allowNull: true },
  // DATEONLY, not DATE - these are SQL DATE columns (no time component).
  // Sequelize returns DATEONLY as a plain 'YYYY-MM-DD' string, unlike the
  // raw mssql driver which returns a Date object for the same SQL type -
  // antivirusInstallModel.js converts it back after every read to keep the
  // API response identical to what it was before this migration.
  plan_date: { type: DataTypes.DATEONLY, allowNull: true },
  due_date: { type: DataTypes.DATEONLY, allowNull: true },
  completed_date: { type: DataTypes.DATEONLY, allowNull: true },
  remark: { type: DataTypes.STRING(255), allowNull: true },
}, {
  tableName: 'antivirus_install',
  schema: 'dbo',
  timestamps: false,
});

module.exports = AntivirusInstall;
