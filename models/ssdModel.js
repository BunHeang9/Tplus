const sequelize = require('../config/sequelize');
const { QueryTypes } = require('sequelize');
const SsdProcurement = require('./sequelize/ssdProcurementModel');

// SSD upgrade tracking (dbo.ssd_upgrade) and the separate procurement
// decision list (dbo.ssd_procurement) - who is getting a drive swapped and
// what capacity to buy going forward. Two tables, one small domain, so they
// share this file rather than each getting its own for two read queries.

// A 3-table join (employee, department, equipment) - raw query through
// Sequelize rather than ORM associations, same reasoning as
// deviceReplacementModel/filterModel.
async function getSsdUpgrades() {
  return sequelize.query(`
    SELECT
      su.upgrade_id,
      su.employee_id,
      emp.full_name AS owner_name,
      d.department_code AS owner_department,
      emp.location AS owner_location,
      su.equipment_id,
      e.computer_name,
      e.device_model,
      e.asset_code AS asset_code,
      su.charge_cable_needed,
      su.replace_status,
      su.ssd_capacity,
      su.ssd_equipment_code,
      su.remark
    FROM dbo.ssd_upgrade su
    LEFT JOIN dbo.employee emp ON su.employee_id = emp.employee_id
    LEFT JOIN dbo.department d ON emp.department_id = d.department_id
    LEFT JOIN dbo.equipment e ON su.equipment_id = e.equipment_id
    ORDER BY su.upgrade_id
  `, { type: QueryTypes.SELECT });
}

// A plain single-table read - real ORM model.
async function getSsdProcurement() {
  return SsdProcurement.findAll({
    attributes: ['procurement_id', 'model_name', 'qty', 'decision'],
    order: [['procurement_id', 'ASC']],
    raw: true,
  });
}

module.exports = { getSsdUpgrades, getSsdProcurement };
