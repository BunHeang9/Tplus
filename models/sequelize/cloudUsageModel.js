const { DataTypes } = require('sequelize');
const sequelize = require('../../config/sequelize');

const CloudUsage = sequelize.define('CloudUsage', {
  usage_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  item_name: { type: DataTypes.STRING(30), allowNull: false },
  unit: { type: DataTypes.STRING(10), allowNull: true },
  unit_cost: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
  usage_month: { type: DataTypes.CHAR(7), allowNull: true }, // 'YYYY-MM'
  quantity: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
  amount: { type: DataTypes.DECIMAL(14, 2), allowNull: true },
}, {
  tableName: 'cloud_usage',
  schema: 'dbo',
  timestamps: false,
});

module.exports = CloudUsage;
