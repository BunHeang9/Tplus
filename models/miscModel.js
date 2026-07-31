const { poolPromise } = require('../config/db');

// Queries for the supporting tables: SSD, licences, servers,
// antivirus, replacements and cloud costs.
// Each returns names rather than bare IDs so the frontend can display
// results without extra lookups.

async function getSsdUpgrades() {
  const pool = await poolPromise;
  const result = await pool.request().query(`
    SELECT
      su.upgrade_id,
      su.employee_id,
      emp.full_name AS owner_name,
      d.department_code AS owner_department,
      emp.location AS owner_location,
      su.equipment_id,
      e.computer_name,
      e.device_model,
      e.equipment_code AS asset_code,
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
  `);
  return result.recordset;
}

async function getSsdProcurement() {
  const pool = await poolPromise;
  const result = await pool.request().query(`
    SELECT procurement_id, model_name, qty, decision
    FROM dbo.ssd_procurement
    ORDER BY procurement_id
  `);
  return result.recordset;
}

async function getLicenses() {
  const pool = await poolPromise;
  const result = await pool.request().query(`
    SELECT license_id, product_name, product_type, date_expire, date_renewed, status, remark
    FROM dbo.license
    ORDER BY date_expire
  `);
  return result.recordset;
}

async function getServerUsage() {
  const pool = await poolPromise;
  const result = await pool.request().query(`
    SELECT
      su.usage_id,
      su.equipment_id,
      e.computer_name,
      e.device_model,
      e.mac_address,
      e.ip_address,
      e.location AS device_location,
      su.owner_id,
      emp.full_name AS owner_name,
      su.cpu_core_total,
      su.memory_gb_total,
      su.hdd_gb_total,
      su.cpu_usage_pct,
      su.memory_usage_pct,
      su.hdd_usage_gb,
      su.antivirus_status,
      su.os_type,
      su.os_version,
      su.windows_license_active,
      su.sql_version,
      su.sql_license_active,
      su.platform,
      su.service_date,
      su.service_running,
      su.status_check,
      su.reinstall_antivirus,
      su.remark
    FROM dbo.server_usage su
    LEFT JOIN dbo.equipment e ON su.equipment_id = e.equipment_id
    LEFT JOIN dbo.employee emp ON su.owner_id = emp.employee_id
    ORDER BY emp.full_name, su.usage_id
  `);
  return result.recordset;
}

async function getAntivirus() {
  const pool = await poolPromise;
  const result = await pool.request().query(`
    SELECT
      av.install_id,
      av.equipment_id,
      e.computer_name,
      e.device_model,
      e.equipment_code AS asset_code,
      emp.full_name AS owner_name,
      av.antivirus_status,
      av.windows_server_license,
      av.plan_date,
      av.due_date,
      av.completed_date,
      av.remark
    FROM dbo.antivirus_install av
    LEFT JOIN dbo.equipment e ON av.equipment_id = e.equipment_id
    LEFT JOIN dbo.employee emp ON e.owner_id = emp.employee_id
    ORDER BY av.install_id
  `);
  return result.recordset;
}

async function getReplacements() {
  const pool = await poolPromise;
  const result = await pool.request().query(`
    SELECT
      dr.replacement_id,
      dr.employee_id,
      emp.full_name AS owner_name,
      d.department_code AS owner_department,
      old_eq.computer_name AS old_computer_name,
      old_eq.device_model AS old_device_model,
      old_eq.service_tag AS old_service_tag,
      old_eq.equipment_code AS old_asset_code,
      dr.old_device_status,
      dr.old_device_location,
      dr.old_bag, dr.old_mouse, dr.old_keyboard,
      new_eq.computer_name AS new_computer_name,
      new_eq.device_model AS new_device_model,
      new_eq.service_tag AS new_service_tag,
      new_eq.equipment_code AS new_asset_code,
      dr.new_bag, dr.new_mouse, dr.new_keyboard,
      dr.new_owner_location,
      dr.replacement_date
    FROM dbo.device_replacement dr
    LEFT JOIN dbo.employee emp ON dr.employee_id = emp.employee_id
    LEFT JOIN dbo.department d ON emp.department_id = d.department_id
    LEFT JOIN dbo.equipment old_eq ON dr.old_equipment_id = old_eq.equipment_id
    LEFT JOIN dbo.equipment new_eq ON dr.new_equipment_id = new_eq.equipment_id
    ORDER BY dr.replacement_date DESC, dr.replacement_id
  `);
  return result.recordset;
}

async function getCloudRates() {
  const pool = await poolPromise;
  const result = await pool.request().query(`
    SELECT rate_id, item_name, unit, capacity, price_type,
           unit_price, total_price_month, total_price_year, year
    FROM dbo.cloud_rate
    ORDER BY year, rate_id
  `);
  return result.recordset;
}

async function getCloudUsage() {
  const pool = await poolPromise;
  const result = await pool.request().query(`
    SELECT usage_id, item_name, unit, unit_cost, usage_month, quantity, amount
    FROM dbo.cloud_usage
    ORDER BY usage_month, usage_id
  `);
  return result.recordset;
}

module.exports = {
  getSsdUpgrades,
  getSsdProcurement,
  getLicenses,
  getServerUsage,
  getAntivirus,
  getReplacements,
  getCloudRates,
  getCloudUsage,
};
