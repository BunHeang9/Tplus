const { DataTypes } = require('sequelize');
const sequelize = require('../../config/sequelize');

const EquipmentStatus = sequelize.define('EquipmentStatus', {
  status_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  status_name: { type: DataTypes.STRING(50), allowNull: false },
  description: { type: DataTypes.STRING(255), allowNull: true },
  has_owner: { type: DataTypes.BOOLEAN, allowNull: true },
  is_assignable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  is_borrowable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  sort_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 99 },
  is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  // Has its own DB-side default (legacy DATETIME) - let the DB fill it in,
  // same reasoning as every other table with this pattern in this migration.
  created_at: { type: DataTypes.DATE, allowNull: true },
}, {
  tableName: 'equipment_status',
  schema: 'dbo',
  timestamps: false,
});

module.exports = EquipmentStatus;
