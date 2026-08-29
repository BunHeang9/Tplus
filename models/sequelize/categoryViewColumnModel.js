const { DataTypes } = require('sequelize');
const sequelize = require('../../config/sequelize');

const CategoryViewColumn = sequelize.define('CategoryViewColumn', {
  view_column_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  category_id: { type: DataTypes.INTEGER, allowNull: false },
  field_name: { type: DataTypes.STRING(100), allowNull: false },
  header_text: { type: DataTypes.STRING(100), allowNull: false },
  sort_order: { type: DataTypes.INTEGER, allowNull: false },
  is_editable: { type: DataTypes.BOOLEAN, allowNull: false },
  // Has its own DB-side default (legacy DATETIME) - let the DB fill it in,
  // same reasoning as every other table with this pattern in this migration.
  created_at: { type: DataTypes.DATE, allowNull: true },
}, {
  tableName: 'category_view_column',
  schema: 'dbo',
  timestamps: false,
});

module.exports = CategoryViewColumn;
