const { DataTypes } = require('sequelize');
const sequelize = require('../../config/sequelize');

const SsdProcurement = sequelize.define('SsdProcurement', {
  procurement_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  model_name: { type: DataTypes.STRING(60), allowNull: false },
  qty: { type: DataTypes.INTEGER, allowNull: false },
  decision: { type: DataTypes.STRING(20), allowNull: true },
}, {
  tableName: 'ssd_procurement',
  schema: 'dbo',
  timestamps: false,
});

module.exports = SsdProcurement;
