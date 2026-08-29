const { DataTypes } = require('sequelize');
const sequelize = require('../../config/sequelize');

// Which devices a license is installed on - composite primary key
// (equipment_id, license_id), mirroring equipment_category_field.
const EquipmentSoftwareLicense = sequelize.define('EquipmentSoftwareLicense', {
  equipment_id: { type: DataTypes.INTEGER, primaryKey: true },
  license_id: { type: DataTypes.INTEGER, primaryKey: true },
  installed_date: { type: DataTypes.DATEONLY, allowNull: true },
  remark: { type: DataTypes.STRING(255), allowNull: true },
  // Legacy DATETIME with its own DB-side default - declared nullable here
  // (not the real schema) so a bulkCreate that never sets it omits the
  // column and lets the DB default fill it in.
  created_at: { type: DataTypes.DATE, allowNull: true },
}, {
  tableName: 'equipment_software_license',
  schema: 'dbo',
  timestamps: false,
});

module.exports = { EquipmentSoftwareLicense };
