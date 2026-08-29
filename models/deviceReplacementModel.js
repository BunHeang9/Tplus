const sequelize = require('../config/sequelize');
const { QueryTypes } = require('sequelize');

// Whole-device swaps (dbo.device_replacement) - an employee's laptop
// replaced with a different one, old accessories (bag/mouse/keyboard)
// carried over or not. Separate from dbo.part_replacement, which handles a
// component changing inside a device that otherwise stays put (partModel.js
// has the full explanation).
//
// This is a 5-table reporting join with two self-joins to dbo.equipment
// (old device vs new device) - modeled here as a raw query through Sequelize
// rather than ORM associations. Building real belongsTo/hasMany relations
// for Employee/Department/Equipment just for this one report would mean
// modeling three other tables correctly for their own much bigger separate
// uses elsewhere, not just this join - out of scope for migrating this one
// function. sequelize.query() still goes through the same Sequelize
// connection pool and parameter binding, it just isn't forced through
// .findAll()/.include() for a query shape that doesn't fit it.
async function getReplacements() {
  const rows = await sequelize.query(`
    SELECT
      dr.replacement_id,
      dr.employee_id,
      emp.full_name AS owner_name,
      d.department_code AS owner_department,
      old_eq.computer_name AS old_computer_name,
      old_eq.device_model AS old_device_model,
      old_eq.service_tag AS old_service_tag,
      old_eq.asset_code AS old_asset_code,
      dr.old_device_status,
      dr.old_device_location,
      dr.old_bag, dr.old_mouse, dr.old_keyboard,
      new_eq.computer_name AS new_computer_name,
      new_eq.device_model AS new_device_model,
      new_eq.service_tag AS new_service_tag,
      new_eq.asset_code new_asset_code,
      dr.new_bag, dr.new_mouse, dr.new_keyboard,
      dr.new_owner_location,
      dr.replacement_date
    FROM dbo.device_replacement dr
    LEFT JOIN dbo.employee emp ON dr.employee_id = emp.employee_id
    LEFT JOIN dbo.department d ON emp.department_id = d.department_id
    LEFT JOIN dbo.equipment old_eq ON dr.old_equipment_id = old_eq.equipment_id
    LEFT JOIN dbo.equipment new_eq ON dr.new_equipment_id = new_eq.equipment_id
    ORDER BY dr.replacement_date DESC, dr.replacement_id
  `, { type: QueryTypes.SELECT });

  // The raw mssql driver returns a real Date object for a DATE column,
  // which JSON.stringify turns into a full ISO datetime string
  // ("2026-08-18T00:00:00.000Z"). Sequelize's raw query returns a plain
  // date string ("2026-08-18") instead, since there's no model attribute
  // here telling it this column is a date. Converting it back keeps the
  // API response identical to what it was before this migration.
  for (const row of rows) {
    if (row.replacement_date) row.replacement_date = new Date(row.replacement_date);
  }
  return rows;
}

module.exports = { getReplacements };
