const { DataTypes } = require('sequelize');
const sequelize = require('../config/sequelize');
const { QueryTypes } = require('sequelize');

// Software licences and which devices they are installed on.
//
// A device can hold several licences and a licence can cover several devices,
// so the link lives in dbo.equipment_software_license rather than a column on
// either table.

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

// Status is worked out in SQL once here, reused by every query in this file
// (list, single-license lookup, create, update) - two separate
// implementations of the same rule eventually disagree, and then the
// licence list and a single license's page show different things for the
// same row. 'near expire' has a space, not 'near_expire' - keep it that way
// everywhere this value is compared against.
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

// Raw queries with no model attribute definition return a plain 'YYYY-MM-DD'
// string for a DATE column; the driver this replaces returned a Date object
// for the same column. Converting back keeps every response identical to
// before this migration. Also covers installed_date coming back through the
// EquipmentSoftwareLicense model, whose DATEONLY type has the same
// string-not-Date behaviour as an unmapped raw read.
const DATE_FIELDS = ['date_start', 'date_expire', 'installed_date'];
function fixDates(row) {
  if (!row) return row;
  for (const f of DATE_FIELDS) {
    if (row[f]) row[f] = new Date(row[f]);
  }
  return row;
}

// Every licence, for the dropdown on the equipment form. install_count lets the
// frontend show "Office 365 (12 devices)" so an admin can see what is already
// in heavy use.
async function getAllLicenses() {
  const rows = await sequelize.query(`
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
  `, { type: QueryTypes.SELECT });
  return rows.map(fixDates);
}

// All licences on one device. Returns an array - a laptop may have Office and
// Adobe and an antivirus product at once.
async function getEquipmentLicenses(equipmentId) {
  const rows = await sequelize.query(`
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
      WHERE l.equipment_id = :equipment_id
      ORDER BY sl.product_name
    `, { replacements: { equipment_id: equipmentId }, type: QueryTypes.SELECT });
  return rows.map(fixDates);
}

// The reverse: which devices a licence is installed on. Answers "we have 50
// seats - how many are used, and by whom?"
async function getLicenseEquipment(licenseId) {
  const rows = await sequelize.query(`
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
      WHERE l.license_id = :license_id
      ORDER BY e.device_name, e.computer_name
    `, { replacements: { license_id: licenseId }, type: QueryTypes.SELECT });
  return rows.map(fixDates);
}

// Adds a licence to a device, leaving any others in place.
//
// MERGE rather than INSERT so assigning the same licence twice updates the
// install date instead of failing on the primary key - a frontend that
// re-submits a form should not produce an error. COALESCE-per-field on the
// UPDATE branch, not a real upsert, so this stays a raw query rather than
// Sequelize's upsert() (which would overwrite rather than merge).
async function assignLicenseToEquipment(equipmentId, licenseId, { installedDate, remark } = {}) {
  await sequelize.query(`
      MERGE dbo.equipment_software_license AS target
      USING (SELECT :equipment_id AS equipment_id, :license_id AS license_id) AS source
      ON target.equipment_id = source.equipment_id AND target.license_id = source.license_id
      WHEN MATCHED THEN
        UPDATE SET installed_date = COALESCE(:installed_date, target.installed_date),
                   remark = COALESCE(:remark, target.remark)
      WHEN NOT MATCHED THEN
        INSERT (equipment_id, license_id, installed_date, remark)
        VALUES (:equipment_id, :license_id, :installed_date, :remark);
    `, {
    replacements: {
      equipment_id: equipmentId,
      license_id: licenseId,
      installed_date: installedDate || null,
      remark: remark || null,
    },
  });

  return getEquipmentLicenses(equipmentId);
}

// Removes one licence from one device. Both ids are needed - without the
// licence id this would have to guess which of several to remove.
async function removeLicenseFromEquipment(equipmentId, licenseId) {
  const row = await EquipmentSoftwareLicense.findOne({
    where: { equipment_id: equipmentId, license_id: licenseId },
    raw: true,
  });
  if (!row) return null;
  await EquipmentSoftwareLicense.destroy({
    where: { equipment_id: equipmentId, license_id: licenseId },
  });
  return fixDates(row);
}

// Replaces the whole set for a device in one transaction - for a form that
// shows tick boxes and saves the result. A partial save would leave the device
// with some licences applied and others not. Self-contained (no external
// transaction interop), so a real sequelize.transaction() works cleanly here.
async function setEquipmentLicenses(equipmentId, licenseIds) {
  await sequelize.transaction(async (transaction) => {
    await EquipmentSoftwareLicense.destroy({ where: { equipment_id: equipmentId }, transaction });

    if (licenseIds && licenseIds.length > 0) {
      await EquipmentSoftwareLicense.bulkCreate(
        licenseIds.map((licenseId) => ({ equipment_id: equipmentId, license_id: licenseId })),
        { transaction },
      );
    }
  });

  return getEquipmentLicenses(equipmentId);
}

// Licences for a whole page of equipment in one query, rather than one per row.
async function getLicensesForMany(equipmentIds) {
  if (!equipmentIds || equipmentIds.length === 0) return {};

  const rows = await sequelize.query(`
    SELECT l.equipment_id, sl.license_id, sl.product_name, sl.license_type,
           sl.date_start, sl.date_expire,
           ${STATUS_CASE} AS status
    FROM dbo.equipment_software_license l
    JOIN dbo.software_license sl ON l.license_id = sl.license_id
    WHERE l.equipment_id IN (:ids)
    ORDER BY sl.product_name
  `, { replacements: { ids: equipmentIds }, type: QueryTypes.SELECT });

  const byEquipment = {};
  for (const row of rows) {
    fixDates(row);
    if (!byEquipment[row.equipment_id]) byEquipment[row.equipment_id] = [];
    byEquipment[row.equipment_id].push(row);
  }
  return byEquipment;
}

async function findLicenseById(licenseId) {
  const rows = await sequelize.query(`
      SELECT sl.*, ${STATUS_CASE} AS calculated_status
      FROM dbo.software_license sl WHERE sl.license_id = :license_id
    `, { replacements: { license_id: licenseId }, type: QueryTypes.SELECT });
  return fixDates(rows[0]) || null;
}

// --- license definitions (create/edit/delete the product itself, as
// opposed to assigning an existing one to a device, above) ---

// license_type is required: 'Free', 'Annual Subscription', or 'Perpetual'.
// For 'Free' and 'Perpetual', status is always 'active'; for 'Annual
// Subscription' it's calculated from date_start/date_expire via the same
// STATUS_CASE every other query here uses, so this can never disagree with
// what the license list shows for the same row.
//
// Still a raw query, not Sequelize .create(): status is computed by a SQL
// CASE against GETDATE() at insert time, same as STATUS_CASE everywhere
// else in this file - reimplementing that date math in JS would risk a
// subtle mismatch with what every read query here calculates.
async function createLicense(data) {
  const { product_name, product_type, license_type, date_start, date_expire, remark } = data;

  if (!product_name) throw new Error('product_name is required');
  if (!license_type) {
    throw new Error('license_type is required: "Free", "Annual Subscription", or "Perpetual"');
  }
  if (!['Free', 'Annual Subscription', 'Perpetual'].includes(license_type)) {
    throw new Error('license_type must be one of: "Free", "Annual Subscription", or "Perpetual"');
  }
  if (license_type === 'Annual Subscription' && !date_expire) {
    throw new Error('date_expire is required for Annual Subscription licenses');
  }

  const [row] = await sequelize.query(`
      INSERT INTO dbo.software_license (product_name, product_type, license_type, date_start, date_expire, status, remark)
      OUTPUT INSERTED.license_id, INSERTED.product_name, INSERTED.product_type,
             INSERTED.license_type, INSERTED.date_start, INSERTED.date_expire, INSERTED.remark, INSERTED.status
      VALUES (
        :product_name, :product_type, :license_type, :date_start, :date_expire,
        CASE
          WHEN :license_type IN ('Free', 'Perpetual') THEN 'active'
          WHEN :license_type = 'Annual Subscription' THEN
            CASE
              WHEN :date_expire IS NULL THEN 'unknown'
              WHEN :date_expire < CAST(GETDATE() AS DATE) THEN 'expired'
              WHEN :date_expire <= DATEADD(MONTH, 1, CAST(GETDATE() AS DATE)) THEN 'near expire'
              ELSE 'active'
            END
          ELSE 'unknown'
        END,
        :remark
      )
    `, {
    replacements: {
      product_name,
      product_type: product_type || null,
      license_type,
      date_start: date_start || null,
      date_expire: date_expire || null,
      remark: remark || null,
    },
    type: QueryTypes.SELECT,
  });
  return fixDates(row);
}

// Partial update - COALESCE keeps existing values for anything not supplied.
// Status is always recomputed from license_type and dates, never set directly.
// Raw query for the same reason as createLicense above.
async function updateLicense(id, data) {
  const [row] = await sequelize.query(`
      UPDATE dbo.software_license
      SET product_name = COALESCE(:product_name, product_name),
          product_type = COALESCE(:product_type, product_type),
          license_type = COALESCE(:license_type, license_type),
          date_start   = COALESCE(:date_start, date_start),
          date_expire  = COALESCE(:date_expire, date_expire),
          remark       = COALESCE(:remark, remark),
          status = CASE
            WHEN COALESCE(:license_type, license_type) IN ('Free', 'Perpetual') THEN 'active'
            WHEN COALESCE(:license_type, license_type) = 'Annual Subscription' THEN
              CASE
                WHEN COALESCE(:date_expire, date_expire) IS NULL THEN 'unknown'
                WHEN COALESCE(:date_expire, date_expire) < CAST(GETDATE() AS DATE) THEN 'expired'
                WHEN COALESCE(:date_expire, date_expire) <= DATEADD(MONTH, 1, CAST(GETDATE() AS DATE)) THEN 'near expire'
                ELSE 'active'
              END
            ELSE 'unknown'
          END
      OUTPUT INSERTED.license_id, INSERTED.product_name, INSERTED.product_type,
             INSERTED.license_type, INSERTED.date_start, INSERTED.date_expire, INSERTED.remark, INSERTED.status
      WHERE license_id = :id
    `, {
    replacements: {
      id,
      product_name: data.product_name || null,
      product_type: data.product_type || null,
      license_type: data.license_type || null,
      date_start: data.date_start || null,
      date_expire: data.date_expire || null,
      remark: data.remark || null,
    },
    type: QueryTypes.SELECT,
  });
  return fixDates(row) || null;
}

// Deletes the license definition itself (not just one device's assignment
// of it) - captures to recycle bin first, same pattern as every other
// destructive delete in this app.
//
// Self-contained now that recycleBinModel.create() itself takes a Sequelize
// transaction.
async function removeLicense(id, actor) {
  const recycleBinModel = require('./recycleBinModel');

  return sequelize.transaction(async (transaction) => {
    const [license] = await sequelize.query(
      'SELECT * FROM dbo.software_license WHERE license_id = :id',
      { replacements: { id }, type: QueryTypes.SELECT, transaction },
    );
    if (!license) return null;
    fixDates(license);

    await recycleBinModel.create(
      {
        entityType: 'software_license',
        entityId: id,
        entityLabel: license.product_name,
        entityData: license,
        actor,
        reason: 'Software license deleted',
      },
      transaction,
    );

    await sequelize.query(
      'DELETE FROM dbo.software_license WHERE license_id = :id',
      { replacements: { id }, transaction },
    );

    return license;
  });
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
  createLicense,
  updateLicense,
  removeLicense,
};
