const { DataTypes } = require('sequelize');
const sequelize = require('../../config/sequelize');

// Sequelize definition for dbo.cloud_rate. No timestamps on this table -
// it's a static rate card, not something the app stamps with created/updated.
const CloudRate = sequelize.define('CloudRate', {
  rate_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  item_name: { type: DataTypes.STRING(30), allowNull: false },
  unit: { type: DataTypes.STRING(10), allowNull: true },
  capacity: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
  price_type: { type: DataTypes.STRING(10), allowNull: true },
  unit_price: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
  total_price_month: { type: DataTypes.DECIMAL(14, 2), allowNull: true },
  total_price_year: { type: DataTypes.DECIMAL(14, 2), allowNull: true },
  year: { type: DataTypes.INTEGER, allowNull: true },
}, {
  tableName: 'cloud_rate',
  schema: 'dbo',
  timestamps: false,
});

module.exports = CloudRate;
