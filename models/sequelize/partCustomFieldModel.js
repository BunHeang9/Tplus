const { DataTypes } = require('sequelize');
const sequelize = require('../../config/sequelize');

const PartCustomField = sequelize.define('PartCustomField', {
  field_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  field_key: { type: DataTypes.STRING(50), allowNull: false },
  field_label: { type: DataTypes.STRING(100), allowNull: false },
  field_type: { type: DataTypes.STRING(20), allowNull: false },
  // Has its own DB-side default (legacy DATETIME) - let the DB fill it in.
  created_at: { type: DataTypes.DATE, allowNull: true },
  created_by: { type: DataTypes.STRING(50), allowNull: true },
}, {
  tableName: 'part_custom_field',
  schema: 'dbo',
  timestamps: false,
});

// Which part types use which fields - composite primary key, no added_at
// column here (unlike its equipment-side twin, equipment_category_field).
const PartTypeCustomField = sequelize.define('PartTypeCustomField', {
  part_type_id: { type: DataTypes.INTEGER, primaryKey: true },
  field_id: { type: DataTypes.INTEGER, primaryKey: true },
  sort_order: { type: DataTypes.INTEGER, allowNull: false },
  is_required: { type: DataTypes.BOOLEAN, allowNull: false },
}, {
  tableName: 'part_type_custom_field',
  schema: 'dbo',
  timestamps: false,
});

module.exports = { PartCustomField, PartTypeCustomField };
