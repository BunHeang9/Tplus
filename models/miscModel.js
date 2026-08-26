const { poolPromise } = require('../config/db');
const sql = require("mssql");
// Queries for the supporting tables: SSD, software licences, servers,
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
    SELECT 
      license_id, 
      product_name, 
      product_type,
      license_type,
      date_start, 
      date_expire, 
      remark,
      -- Calculated status based on license_type and dates
      CASE
        WHEN license_type IN ('Free', 'Perpetual') THEN 'active'
        WHEN license_type = 'Annual Subscription' THEN
          CASE
            WHEN date_expire IS NULL THEN 'unknown'
            WHEN date_expire < CAST(GETDATE() AS DATE) THEN 'expired'
            WHEN date_expire <= DATEADD(MONTH, 1, CAST(GETDATE() AS DATE)) THEN 'near expire'
            ELSE 'active'
          END
        ELSE 'unknown'
      END AS status
    FROM dbo.software_license
    ORDER BY date_expire
  `);
  return result.recordset;
}

// The capacity-planning calculation sheet ("Plan optimize"): Total Capacity
// vs Usage vs Reducing vs After Reducing, one row per server. This is
// deliberately separate from "server" (dbo.equipment) - that stores what a
// server is, this calculates what to do about its capacity. Name, IP, Owner
// AND Total Capacity are not duplicated here; they come from dbo.equipment
// (cpu/ram/hd is the same fact as Total Capacity, so there's no separate
// column to keep in sync - editing either side edits the one real value).
// TRY_CAST rather than CAST: a non-numeric cpu/ram/hd (free text like
// "Core i5") should show up here as blank, not break the whole query.
async function getServerUsage() {
  const pool = await poolPromise;
  const result = await pool.request().query(`
    SELECT
      su.usage_id,
      su.equipment_id,
      e.device_name,
      e.ip_address,
      e.owner_id,
      emp.full_name AS owner_name,
      su.plan_date,
      su.due_date,
      TRY_CAST(e.cpu AS INT) AS cpu_core_total,
      TRY_CAST(e.ram AS INT) AS memory_gb_total,
      TRY_CAST(e.hd  AS INT) AS hdd_gb_total,
      su.cpu_usage_pct,
      su.memory_usage_pct,
      su.hdd_usage_gb,
      su.reducing_cpu_core,
      su.reducing_memory_gb,
      su.after_reducing_cpu_core,
      su.after_reducing_memory_gb,
      su.remark
    FROM dbo.server_usage su
    LEFT JOIN dbo.equipment e   ON su.equipment_id = e.equipment_id
    LEFT JOIN dbo.employee emp  ON e.owner_id = emp.employee_id
    ORDER BY e.device_name, su.usage_id
  `);
  return result.recordset;
}

// Sets the calculation fields for one equipment - MERGE so an
// admin filling this in doesn't need to know whether a row already exists
// for that server, the same way part_stock's increment() spares the caller
// from that. COALESCE keeps a field already recorded when this update
// leaves it out, rather than blanking it back to null.
async function upsertServerUsage(equipmentId, d) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('equipment_id', sql.Int, equipmentId)
    .input('plan_date', sql.Date, d.plan_date ?? null)
    .input('due_date', sql.Date, d.due_date ?? null)
    .input('cpu_usage_pct', sql.VarChar, d.cpu_usage_pct ?? null)
    .input('memory_usage_pct', sql.VarChar, d.memory_usage_pct ?? null)
    .input('hdd_usage_gb', sql.Decimal(10, 2), d.hdd_usage_gb ?? null)
    .input('reducing_cpu_core', sql.Int, d.reducing_cpu_core ?? null)
    .input('reducing_memory_gb', sql.Int, d.reducing_memory_gb ?? null)
    .input('after_reducing_cpu_core', sql.Int, d.after_reducing_cpu_core ?? null)
    .input('after_reducing_memory_gb', sql.Int, d.after_reducing_memory_gb ?? null)
    .input('remark', sql.VarChar, d.remark ?? null)
    .query(`
      MERGE dbo.server_usage AS target
      USING (SELECT @equipment_id AS equipment_id) AS source
      ON target.equipment_id = source.equipment_id
      WHEN MATCHED THEN UPDATE SET
        plan_date = COALESCE(@plan_date, plan_date),
        due_date = COALESCE(@due_date, due_date),
        cpu_usage_pct = COALESCE(@cpu_usage_pct, cpu_usage_pct),
        memory_usage_pct = COALESCE(@memory_usage_pct, memory_usage_pct),
        hdd_usage_gb = COALESCE(@hdd_usage_gb, hdd_usage_gb),
        reducing_cpu_core = COALESCE(@reducing_cpu_core, reducing_cpu_core),
        reducing_memory_gb = COALESCE(@reducing_memory_gb, reducing_memory_gb),
        after_reducing_cpu_core = COALESCE(@after_reducing_cpu_core, after_reducing_cpu_core),
        after_reducing_memory_gb = COALESCE(@after_reducing_memory_gb, after_reducing_memory_gb),
        remark = COALESCE(@remark, remark)
      WHEN NOT MATCHED THEN INSERT (
        equipment_id, plan_date, due_date,
        cpu_usage_pct, memory_usage_pct, hdd_usage_gb,
        reducing_cpu_core, reducing_memory_gb,
        after_reducing_cpu_core, after_reducing_memory_gb, remark
      ) VALUES (
        @equipment_id, @plan_date, @due_date,
        @cpu_usage_pct, @memory_usage_pct, @hdd_usage_gb,
        @reducing_cpu_core, @reducing_memory_gb,
        @after_reducing_cpu_core, @after_reducing_memory_gb, @remark
      )
      OUTPUT INSERTED.*;
    `);
  return result.recordset[0];
}

async function removeServerUsage(usageId) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('id', sql.Int, usageId)
    .query('DELETE FROM dbo.server_usage OUTPUT DELETED.* WHERE usage_id = @id');
  return result.recordset[0] || null;
}

// A device can be reinstalled more than once, so this always adds a new
// row rather than merging into an existing one the way server_usage does -
// each install attempt is its own record, not a single fact being corrected.
async function createAntivirusInstall(d) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('equipment_id', sql.Int, d.equipment_id)
    .input('antivirus_status', sql.VarChar, d.antivirus_status ?? null)
    .input('windows_server_license', sql.Bit, d.windows_server_license ?? null)
    .input('plan_date', sql.Date, d.plan_date ?? null)
    .input('due_date', sql.Date, d.due_date ?? null)
    .input('completed_date', sql.Date, d.completed_date ?? null)
    .input('remark', sql.VarChar, d.remark ?? null)
    .query(`
      INSERT INTO dbo.antivirus_install
        (equipment_id, antivirus_status, windows_server_license, plan_date, due_date, completed_date, remark)
      OUTPUT INSERTED.*
      VALUES (@equipment_id, @antivirus_status, @windows_server_license, @plan_date, @due_date, @completed_date, @remark)
    `);
  return result.recordset[0];
}

async function updateAntivirusInstall(installId, d) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('id', sql.Int, installId)
    .input('antivirus_status', sql.VarChar, d.antivirus_status)
    .input('windows_server_license', sql.Bit, d.windows_server_license === undefined ? null : d.windows_server_license)
    .input('plan_date', sql.Date, d.plan_date)
    .input('due_date', sql.Date, d.due_date)
    .input('completed_date', sql.Date, d.completed_date)
    .input('remark', sql.VarChar, d.remark)
    .query(`
      UPDATE dbo.antivirus_install
      SET antivirus_status = COALESCE(@antivirus_status, antivirus_status),
          windows_server_license = COALESCE(@windows_server_license, windows_server_license),
          plan_date = COALESCE(@plan_date, plan_date),
          due_date = COALESCE(@due_date, due_date),
          completed_date = COALESCE(@completed_date, completed_date),
          remark = COALESCE(@remark, remark)
      OUTPUT INSERTED.*
      WHERE install_id = @id
    `);
  return result.recordset[0] || null;
}

async function removeAntivirusInstall(installId) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('id', sql.Int, installId)
    .query('DELETE FROM dbo.antivirus_install OUTPUT DELETED.* WHERE install_id = @id');
  return result.recordset[0] || null;
}

async function getAntivirus() {
  const pool = await poolPromise;
  const result = await pool.request().query(`
    SELECT
      av.install_id,
      av.equipment_id,
      e.computer_name,
      e.device_model,
      e.asset_code AS asset_code,
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

// Create new software license
// license_type is required: 'Free', 'Annual Subscription', or 'Perpetual'
// For 'Free' and 'Perpetual', status is always 'active'
// For 'Annual Subscription', status is calculated from date_start and date_expire
async function createLicense(data) {
  const {
    product_name,
    product_type,
    license_type,
    date_start,
    date_expire,
    remark,
  } = data;

  if (!product_name) {
    throw new Error("product_name is required");
  }
  if (!license_type) {
    throw new Error(
      'license_type is required: "Free", "Annual Subscription", or "Perpetual"',
    );
  }
  if (!["Free", "Annual Subscription", "Perpetual"].includes(license_type)) {
    throw new Error(
      'license_type must be one of: "Free", "Annual Subscription", or "Perpetual"',
    );
  }

  // For Annual Subscription, date_expire is required
  if (license_type === "Annual Subscription" && !date_expire) {
    throw new Error("date_expire is required for Annual Subscription licenses");
  }

  const pool = await poolPromise;
  const result = await pool
    .request()
    .input("product_name", sql.NVarChar, product_name)
    .input("product_type", sql.VarChar, product_type || null)
    .input("license_type", sql.VarChar, license_type)
    .input("date_start", sql.Date, date_start || null)
    .input("date_expire", sql.Date, date_expire || null)
    .input("remark", sql.NVarChar, remark || null).query(`
      INSERT INTO dbo.software_license (product_name, product_type, license_type, date_start, date_expire, status, remark)
      OUTPUT INSERTED.license_id, INSERTED.product_name, INSERTED.product_type,
             INSERTED.license_type, INSERTED.date_start, INSERTED.date_expire, INSERTED.remark, INSERTED.status
      VALUES (
        @product_name, @product_type, @license_type, @date_start, @date_expire,
        CASE
          WHEN @license_type IN ('Free', 'Perpetual') THEN 'active'
          WHEN @license_type = 'Annual Subscription' THEN
            CASE
              WHEN @date_expire IS NULL THEN 'unknown'
              WHEN @date_expire < CAST(GETDATE() AS DATE) THEN 'expired'
              WHEN @date_expire <= DATEADD(MONTH, 1, CAST(GETDATE() AS DATE)) THEN 'near expire'
              ELSE 'active'
            END
          ELSE 'unknown'
        END,
        @remark
      )
    `);
  return result.recordset[0];
}

// Update software license
// Partial update - COALESCE keeps existing values for anything not supplied
// Status is always recomputed based on license_type and dates
async function updateLicense(id, data) {
  const pool = await poolPromise;
  
  const result = await pool
    .request()
    .input("id", sql.Int, id)
    .input("product_name", sql.NVarChar, data.product_name || null)
    .input("product_type", sql.VarChar, data.product_type || null)
    .input("license_type", sql.VarChar, data.license_type || null)
    .input("date_start", sql.Date, data.date_start || null)
    .input("date_expire", sql.Date, data.date_expire || null)
    .input("remark", sql.NVarChar, data.remark || null).query(`
      UPDATE dbo.software_license
      SET product_name = COALESCE(@product_name, product_name),
          product_type = COALESCE(@product_type, product_type),
          license_type = COALESCE(@license_type, license_type),
          date_start   = COALESCE(@date_start, date_start),
          date_expire  = COALESCE(@date_expire, date_expire),
          remark       = COALESCE(@remark, remark),
          status = CASE
            WHEN COALESCE(@license_type, license_type) IN ('Free', 'Perpetual') THEN 'active'
            WHEN COALESCE(@license_type, license_type) = 'Annual Subscription' THEN
              CASE
                WHEN COALESCE(@date_expire, date_expire) IS NULL THEN 'unknown'
                WHEN COALESCE(@date_expire, date_expire) < CAST(GETDATE() AS DATE) THEN 'expired'
                WHEN COALESCE(@date_expire, date_expire) <= DATEADD(MONTH, 1, CAST(GETDATE() AS DATE)) THEN 'near expire'
                ELSE 'active'
              END
            ELSE 'unknown'
          END
      OUTPUT INSERTED.license_id, INSERTED.product_name, INSERTED.product_type,
             INSERTED.license_type, INSERTED.date_start, INSERTED.date_expire, INSERTED.remark, INSERTED.status
      WHERE license_id = @id
    `);
  return result.recordset[0] || null;
}

async function findLicenseById(id) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input("id", sql.Int, id)
    .query("SELECT * FROM dbo.software_license WHERE license_id = @id");
  return result.recordset[0] || null;
}

// Remove software license - captures to recycle bin first
async function removeLicense(id, actor) {
  const recycleBinModel = require('./recycleBinModel');
  const pool = await poolPromise;
  const transaction = new sql.Transaction(pool);
  await transaction.begin();

  try {
    const row = await new sql.Request(transaction)
      .input("id", sql.Int, id)
      .query("SELECT * FROM dbo.software_license WHERE license_id = @id");

    const license = row.recordset[0];
    if (!license) {
      await transaction.rollback();
      return null;
    }

    await recycleBinModel.create(
      {
        entityType: "software_license",
        entityId: id,
        entityLabel: license.product_name,
        entityData: license,
        actor,
        reason: "Software license deleted",
      },
      transaction,
    );

    await new sql.Request(transaction)
      .input("id", sql.Int, id)
      .query("DELETE FROM dbo.software_license WHERE license_id = @id");

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
  upsertServerUsage,
  removeServerUsage,
  getAntivirus,
  createAntivirusInstall,
  updateAntivirusInstall,
  removeAntivirusInstall,
  getReplacements,
  getCloudRates,
  getCloudUsage,
  createLicense,
  updateLicense,
  findLicenseById,
  removeLicense,
};
