const { poolPromise } = require('../config/db');
const sql = require('mssql');

// Software licences and which devices they are installed on.
//
// A device can hold several licences and a licence can cover several devices,
// so the link lives in dbo.equipment_software_license rather than a column on
// either table.

// Status is worked out in SQL here rather than in JavaScript, so this file and
// miscModel.getLicenses cannot drift apart - two implementations of the same
// rule eventually disagree, and then the licence list and the equipment page
// show different things for the same licence.
//
// The values match miscModel exactly: 'near expire' with a space, not
// 'near_expire'.
const STATUS_CASE = `
      CASE
        WHEN sl.license_type IN ('Free', 'Perpetual') THEN 'active'
        WHEN sl.license_type = 'Annual Subscription' THEN
          CASE
            WHEN sl.date_expire IS NULL THEN 'unknown'
            WHEN sl.date_expire < CAST(GETDATE() AS DATE) THEN 'expired'
            WHEN sl.date_expire <= DATEADD(MONTH, 1, CAST(GETDATE() AS DATE)) THEN 'near expire'
            ELSE 'active'
          END
        ELSE 'unknown'
      END`;

// Every licence, for the dropdown on the equipment form. install_count lets the
// frontend show "Office 365 (12 devices)" so an admin can see what is already
// in heavy use.
async function getAllLicenses() {
  const pool = await poolPromise;
  const result = await pool.request().query(`
    SELECT
      sl.license_id,
      sl.product_name,
      sl.product_type,
      sl.license_type,
      sl.date_start,
      sl.date_expire,
      sl.remark,
      ${STATUS_CASE} AS status,
      (SELECT COUNT(*) FROM dbo.equipment_software_license l
        WHERE l.license_id = sl.license_id) AS install_count
    FROM dbo.software_license sl
    ORDER BY sl.product_name ASC
  `);
  return result.recordset;
}

// All licences on one device. Returns an array - a laptop may have Office and
// Adobe and an antivirus product at once.
async function getEquipmentLicenses(equipmentId) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('equipment_id', sql.Int, equipmentId)
    .query(`
      SELECT
        sl.license_id,
        sl.product_name,
        sl.product_type,
        sl.license_type,
        sl.date_start,
        sl.date_expire,
        sl.remark,
        ${STATUS_CASE} AS status,
        l.installed_date,
        l.remark AS install_remark
      FROM dbo.equipment_software_license l
      JOIN dbo.software_license sl ON l.license_id = sl.license_id
      WHERE l.equipment_id = @equipment_id
      ORDER BY sl.product_name
    `);
  return result.recordset;
}

// The reverse: which devices a licence is installed on. Answers "we have 50
// seats - how many are used, and by whom?"
async function getLicenseEquipment(licenseId) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('license_id', sql.Int, licenseId)
    .query(`
      SELECT
        e.equipment_id,
        e.device_name,
        e.computer_name,
        e.device_model,
        e.asset_code,
        e.status AS equipment_status,
        c.category_name,
        emp.full_name AS owner_name,
        l.installed_date,
        l.remark AS install_remark
      FROM dbo.equipment_software_license l
      JOIN dbo.equipment e ON l.equipment_id = e.equipment_id
      LEFT JOIN dbo.category c ON e.category_id = c.category_id
      LEFT JOIN dbo.employee emp ON e.owner_id = emp.employee_id
      WHERE l.license_id = @license_id
      ORDER BY e.device_name, e.computer_name
    `);
  return result.recordset;
}

// Adds a licence to a device, leaving any others in place.
//
// MERGE rather than INSERT so assigning the same licence twice updates the
// install date instead of failing on the primary key - a frontend that
// re-submits a form should not produce an error.
async function assignLicenseToEquipment(equipmentId, licenseId, { installedDate, remark } = {}) {
  const pool = await poolPromise;
  await pool
    .request()
    .input('equipment_id', sql.Int, equipmentId)
    .input('license_id', sql.Int, licenseId)
    .input('installed_date', sql.Date, installedDate || null)
    .input('remark', sql.NVarChar, remark || null)
    .query(`
      MERGE dbo.equipment_software_license AS target
      USING (SELECT @equipment_id AS equipment_id, @license_id AS license_id) AS source
      ON target.equipment_id = source.equipment_id AND target.license_id = source.license_id
      WHEN MATCHED THEN
        UPDATE SET installed_date = COALESCE(@installed_date, target.installed_date),
                   remark = COALESCE(@remark, target.remark)
      WHEN NOT MATCHED THEN
        INSERT (equipment_id, license_id, installed_date, remark)
        VALUES (@equipment_id, @license_id, @installed_date, @remark);
    `);

  return getEquipmentLicenses(equipmentId);
}

// Removes one licence from one device. Both ids are needed - without the
// licence id this would have to guess which of several to remove.
async function removeLicenseFromEquipment(equipmentId, licenseId) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('equipment_id', sql.Int, equipmentId)
    .input('license_id', sql.Int, licenseId)
    .query(`
      DELETE FROM dbo.equipment_software_license
      OUTPUT DELETED.*
      WHERE equipment_id = @equipment_id AND license_id = @license_id
    `);
  return result.recordset[0] || null;
}

// Replaces the whole set for a device in one transaction - for a form that
// shows tick boxes and saves the result. A partial save would leave the device
// with some licences applied and others not.
async function setEquipmentLicenses(equipmentId, licenseIds) {
  const pool = await poolPromise;
  const transaction = new sql.Transaction(pool);
  await transaction.begin();

  try {
    await new sql.Request(transaction)
      .input('equipment_id', sql.Int, equipmentId)
      .query('DELETE FROM dbo.equipment_software_license WHERE equipment_id = @equipment_id');

    for (const licenseId of licenseIds || []) {
      await new sql.Request(transaction)
        .input('equipment_id', sql.Int, equipmentId)
        .input('license_id', sql.Int, licenseId)
        .query(`
          INSERT INTO dbo.equipment_software_license (equipment_id, license_id)
          VALUES (@equipment_id, @license_id)
        `);
    }

    await transaction.commit();
    return await getEquipmentLicenses(equipmentId);
  } catch (err) {
    try { await transaction.rollback(); } catch { /* already rolled back */ }
    throw err;
  }
}

// Licences for a whole page of equipment in one query, rather than one per row.
async function getLicensesForMany(equipmentIds) {
  if (!equipmentIds || equipmentIds.length === 0) return {};

  const pool = await poolPromise;
  const request = pool.request();
  const params = equipmentIds.map((id, i) => {
    request.input(`e${i}`, sql.Int, id);
    return `@e${i}`;
  });

  const result = await request.query(`
    SELECT l.equipment_id, sl.license_id, sl.product_name, sl.license_type,
           sl.date_start, sl.date_expire,
           ${STATUS_CASE} AS status
    FROM dbo.equipment_software_license l
    JOIN dbo.software_license sl ON l.license_id = sl.license_id
    WHERE l.equipment_id IN (${params.join(',')})
    ORDER BY sl.product_name
  `);

  const byEquipment = {};
  for (const row of result.recordset) {
    if (!byEquipment[row.equipment_id]) byEquipment[row.equipment_id] = [];
    byEquipment[row.equipment_id].push(row);
  }
  return byEquipment;
}

async function findLicenseById(licenseId) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('license_id', sql.Int, licenseId)
    .query(`
      SELECT sl.*, ${STATUS_CASE} AS calculated_status
      FROM dbo.software_license sl WHERE sl.license_id = @license_id
    `);
  return result.recordset[0] || null;
}

module.exports = {
  getAllLicenses,
  getEquipmentLicenses,
  getLicenseEquipment,
  assignLicenseToEquipment,
  removeLicenseFromEquipment,
  setEquipmentLicenses,
  getLicensesForMany,
  findLicenseById,
};