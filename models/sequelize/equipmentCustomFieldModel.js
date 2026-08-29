const { DataTypes } = require('sequelize');
const sequelize = require('../../config/sequelize');

// The field definition itself (dbo.equipment_custom_field).
const EquipmentCustomField = sequelize.define('EquipmentCustomField', {
  field_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  field_key: { type: DataTypes.STRING(50), allowNull: false },
  field_label: { type: DataTypes.STRING(100), allowNull: false },
  field_type: { type: DataTypes.STRING(20), allowNull: false },
  // Has its own DB-side default (legacy DATETIME) - let the DB fill it in,
  // same reasoning as every other table with this pattern in this migration.
  created_at: { type: DataTypes.DATE, allowNull: true },
  created_by: { type: DataTypes.STRING(100), allowNull: true },
}, {
  tableName: 'equipment_custom_field',
  schema: 'dbo',
  timestamps: false,
});

// Which categories use which fields (dbo.equipment_category_field) -
// composite primary key, no identity column of its own.
const EquipmentCategoryField = sequelize.define('EquipmentCategoryField', {
  category_id: { type: DataTypes.INTEGER, primaryKey: true },
  field_id: { type: DataTypes.INTEGER, primaryKey: true },
  sort_order: { type: DataTypes.INTEGER, allowNull: false },
  is_required: { type: DataTypes.BOOLEAN, allowNull: false },
  added_at: { type: DataTypes.DATE, allowNull: true },
}, {
  tableName: 'equipment_category_field',
  schema: 'dbo',
  timestamps: false,
});

// The stored values themselves (dbo.equipment_custom_value) - also a
// composite primary key. Only used for reads here; writes stay in
// models/customFieldModel.js's setValues() (raw SQL, see the comment there).
const EquipmentCustomValue = sequelize.define('EquipmentCustomValue', {
  equipment_id: { type: DataTypes.INTEGER, primaryKey: true },
  field_id: { type: DataTypes.INTEGER, primaryKey: true },
  field_value: { type: DataTypes.STRING(500), allowNull: true },
  updated_at: { type: DataTypes.DATE, allowNull: true },
}, {
  tableName: 'equipment_custom_value',
  schema: 'dbo',
  timestamps: false,
});

module.exports = { EquipmentCustomField, EquipmentCategoryField, EquipmentCustomValue };
