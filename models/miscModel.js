const { poolPromise } = require('../config/db');
const sql = require("mssql");
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
    SELECT license_id, product_name, product_type,
           date_start, date_expire, remark,
           -- Derived rather than stored: a saved status would be wrong the day
           -- after a licence expires, and 'near expire' could never be accurate
           -- without a scheduled job to keep it up to date.
           CASE
             WHEN date_expire IS NULL THEN 'unknown'
             WHEN date_expire < CAST(GETDATE() AS DATE) THEN 'expired'
             WHEN date_expire <= DATEADD(MONTH, 1, CAST(GETDATE() AS DATE)) THEN 'near expire'
             ELSE 'active'
           END AS status
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

// status is never accepted from the caller - it is computed from date_expire.
// Letting someone pick it would allow "active" on a licence that expired last
// week. The stored column is set here only so direct SQL queries see something
// sensible; getLicenses derives it fresh on every read.
async function createLicense(data) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('product_name', sql.NVarChar, data.product_name)
    .input('product_type', sql.VarChar, data.product_type || null)
    .input('date_start', sql.Date, data.date_start || null)
    .input('date_expire', sql.Date, data.date_expire || null)
    .input('remark', sql.NVarChar, data.remark || null)
    .query(`
      INSERT INTO dbo.license (product_name, product_type, date_start, date_expire, status, remark)
      OUTPUT INSERTED.license_id, INSERTED.product_name, INSERTED.product_type,
             INSERTED.date_start, INSERTED.date_expire, INSERTED.remark, INSERTED.status
      VALUES (
        @product_name, @product_type, @date_start, @date_expire,
        CASE
          WHEN @date_expire IS NULL THEN 'unknown'
          WHEN @date_expire < CAST(GETDATE() AS DATE) THEN 'expired'
          WHEN @date_expire <= DATEADD(MONTH, 1, CAST(GETDATE() AS DATE)) THEN 'near expire'
          ELSE 'active'
        END,
        @remark
      )
    `);
  return result.recordset[0];
}
// Partial update - COALESCE keeps existing values for anything not supplied.
// status is always recomputed from the resulting date_expire, so extending an
// expiry moves a licence from 'near expire' back to 'active' automatically.
async function updateLicense(id, data) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('id', sql.Int, id)
    .input('product_name', sql.NVarChar, data.product_name)
    .input('product_type', sql.VarChar, data.product_type)
    .input('date_start', sql.Date, data.date_start)
    .input('date_expire', sql.Date, data.date_expire)
    .input('remark', sql.NVarChar, data.remark)
    .query(`
      UPDATE dbo.license
      SET product_name = COALESCE(@product_name, product_name),
          product_type = COALESCE(@product_type, product_type),
          date_start   = COALESCE(@date_start, date_start),
          date_expire  = COALESCE(@date_expire, date_expire),
          remark       = COALESCE(@remark, remark),
          status = CASE
            WHEN COALESCE(@date_expire, date_expire) IS NULL THEN 'unknown'
            WHEN COALESCE(@date_expire, date_expire) < CAST(GETDATE() AS DATE) THEN 'expired'
            WHEN COALESCE(@date_expire, date_expire) <= DATEADD(MONTH, 1, CAST(GETDATE() AS DATE)) THEN 'near expire'
            ELSE 'active'
          END
      OUTPUT INSERTED.license_id, INSERTED.product_name, INSERTED.product_type,
             INSERTED.date_start, INSERTED.date_expire, INSERTED.remark, INSERTED.status
      WHERE license_id = @id
    `);
  return result.recordset[0] || null;
}

async function findLicenseById(id) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('id', sql.Int, id)
    .query('SELECT * FROM dbo.license WHERE license_id = @id');
  return result.recordset[0] || null;
}

// Captures the row into the recycle bin before removing it, both in one
// transaction - so a failed delete cannot leave an orphaned bin entry, and a
// failed bin write cannot lose the licence.
async function removeLicense(id, actor) {
  const recycleBinModel = require('./recycleBinModel');
  const pool = await poolPromise;
  const transaction = new sql.Transaction(pool);
  await transaction.begin();

  try {
    const row = await new sql.Request(transaction)
      .input('id', sql.Int, id)
      .query('SELECT * FROM dbo.license WHERE license_id = @id');

    const license = row.recordset[0];
    if (!license) {
      await transaction.rollback();
      return null;
    }

    await recycleBinModel.create({
      entityType: 'license',
      entityId: id,
      entityLabel: license.product_name,
      entityData: license,
      actor,
      reason: 'Licence deleted',
    }, transaction);

    await new sql.Request(transaction)
      .input('id', sql.Int, id)
      .query('DELETE FROM dbo.license WHERE license_id = @id');

    await transaction.commit();
    return license;
  } catch (err) {
    try { await transaction.rollback(); } catch { /* already rolled back */ }
    throw err;
  }
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
  createLicense,
  updateLicense,
  findLicenseById,
  removeLicense,
};
