const { DataTypes } = require('sequelize');
const sequelize = require('../../config/sequelize');

const PartTypeStockColumn = sequelize.define('PartTypeStockColumn', {
  view_column_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  part_type_id: { type: DataTypes.INTEGER, allowNull: false },
  field_name: { type: DataTypes.STRING(50), allowNull: false },
  header_text: { type: DataTypes.STRING(100), allowNull: false },
  sort_order: { type: DataTypes.INTEGER, allowNull: false },
}, {
  tableName: 'part_type_stock_column',
  schema: 'dbo',
  timestamps: false,
});

module.exports = PartTypeStockColumn;
