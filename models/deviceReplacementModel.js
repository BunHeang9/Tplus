const { DataTypes } = require('sequelize');
const sequelize = require('../config/sequelize');
const { Equipment } = require('./equipmentModel');
const { Employee } = require('./employeeModel');
const { Department } = require('./departmentModel');

// Whole-device swaps (dbo.device_replacement) - an employee's laptop
// replaced with a different one, old accessories (bag/mouse/keyboard)
// carried over or not. Separate from dbo.part_replacement, which handles a
// component changing inside a device that otherwise stays put (partModel.js
// has the full explanation).

const DeviceReplacement = sequelize.define('DeviceReplacement', {
  replacement_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  employee_id: { type: DataTypes.INTEGER, allowNull: false },
  old_equipment_id: { type: DataTypes.INTEGER, allowNull: true },
  old_warranty_status: { type: DataTypes.STRING(30), allowNull: true },
  old_device_status: { type: DataTypes.STRING(30), allowNull: true },
  old_device_location: { type: DataTypes.STRING(50), allowNull: true },
  old_bag: { type: DataTypes.BOOLEAN, allowNull: true },
  old_mouse: { type: DataTypes.BOOLEAN, allowNull: true },
  old_keyboard: { type: DataTypes.BOOLEAN, allowNull: true },
  new_equipment_id: { type: DataTypes.INTEGER, allowNull: false },
  new_warranty_status: { type: DataTypes.STRING(30), allowNull: true },
  new_owner_location: { type: DataTypes.STRING(100), allowNull: true },
  new_bag: { type: DataTypes.BOOLEAN, allowNull: true },
  new_mouse: { type: DataTypes.BOOLEAN, allowNull: true },
  new_keyboard: { type: DataTypes.BOOLEAN, allowNull: true },
  replacement_date: { type: DataTypes.DATEONLY, allowNull: true },
}, {
  tableName: 'device_replacement',
  schema: 'dbo',
  timestamps: false,
});

// Two self-joins to Equipment under different aliases (old device vs new
// device) - now that Equipment/Employee/Department are all real, exported,
// already-associated models, this reuses them rather than modeling
// anything new. That wasn't true when this file was first migrated (hence
// the raw query it used to be), but is now.
DeviceReplacement.belongsTo(Equipment, { foreignKey: 'old_equipment_id', as: 'oldEquipment' });
DeviceReplacement.belongsTo(Equipment, { foreignKey: 'new_equipment_id', as: 'newEquipment' });
DeviceReplacement.belongsTo(Employee, { foreignKey: 'employee_id', as: 'employee' });

async function getReplacements() {
  const rows = await DeviceReplacement.findAll({
    include: [
      { model: Employee, as: 'employee', include: [{ model: Department, as: 'department' }] },
      { model: Equipment, as: 'oldEquipment' },
      { model: Equipment, as: 'newEquipment' },
    ],
    order: [['replacement_date', 'DESC'], ['replacement_id', 'ASC']],
  });

  return rows.map((row) => {
    const { employee, oldEquipment, newEquipment, ...dr } = row.get({ plain: true });
    const ownerDepartment = employee && employee.department;

    return {
      replacement_id: dr.replacement_id,
      employee_id: dr.employee_id,
      owner_name: employee ? employee.full_name : null,
      owner_department: ownerDepartment ? ownerDepartment.department_code : null,
      old_computer_name: oldEquipment ? oldEquipment.computer_name : null,
      old_device_model: oldEquipment ? oldEquipment.device_model : null,
      old_service_tag: oldEquipment ? oldEquipment.service_tag : null,
      old_asset_code: oldEquipment ? oldEquipment.asset_code : null,
      old_device_status: dr.old_device_status,
      old_device_location: dr.old_device_location,
      old_bag: dr.old_bag,
      old_mouse: dr.old_mouse,
      old_keyboard: dr.old_keyboard,
      new_computer_name: newEquipment ? newEquipment.computer_name : null,
      new_device_model: newEquipment ? newEquipment.device_model : null,
      new_service_tag: newEquipment ? newEquipment.service_tag : null,
      new_asset_code: newEquipment ? newEquipment.asset_code : null,
      new_bag: dr.new_bag,
      new_mouse: dr.new_mouse,
      new_keyboard: dr.new_keyboard,
      new_owner_location: dr.new_owner_location,
      // Equipment/Employee/Department all use DATEONLY-style columns that
      // come back as plain 'YYYY-MM-DD' strings via the ORM, same trade-off
      // already made (and approved) for equipmentModel.js's findAll/findById.
      replacement_date: dr.replacement_date,
    };
  });
}

module.exports = { getReplacements };
