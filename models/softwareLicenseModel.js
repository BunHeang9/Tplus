const { DataTypes, Op } = require('sequelize');
const sequelize = require('../config/sequelize');
const { QueryTypes } = require('sequelize');
const { Equipment } = require('./equipmentModel');
const { Category } = require('./categoryModel');
const { Employee } = require('./employeeModel');

// Software licences and which devices they are installed on.
//
// A device can hold several licences and a licence can cover several devices,
// so the link lives in dbo.equipment_software_license rather than a column on
// either table. Not required by equipmentModel.js, so (like borrowModel.js/
// deviceReplacementModel.js) it's safe for this file to import Equipment and
// build associations onto it.

// dbo.software_license's real columns, declared in their actual physical
// column order (not insertion order - an old ALTER TABLE history left
// date_expire/status/remark before date_start/license_type).
const SoftwareLicense = sequelize.define('SoftwareLicense', {
  license_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  product_name: { type: DataTypes.STRING(100), allowNull: false },
  product_type: { type: DataTypes.STRING(20), allowNull: false },
  date_expire: { type: DataTypes.DATEONLY, allowNull: true },
  status: { type: DataTypes.STRING(20), allowNull: true },
  remark: { type: DataTypes.STRING(255), allowNull: true },
  date_start: { type: DataTypes.DATEONLY, allowNull: true },
  license_type: { type: DataTypes.STRING(50), allowNull: false },
}, {
  tableName: 'software_license',
  schema: 'dbo',
  timestamps: false,
});

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

EquipmentSoftwareLicense.belongsTo(SoftwareLicense, { foreignKey: 'license_id', as: 'license' });
EquipmentSoftwareLicense.belongsTo(Equipment, { foreignKey: 'equipment_id', as: 'equipment' });
SoftwareLicense.hasMany(EquipmentSoftwareLicense, { foreignKey: 'license_id', as: 'installs' });

// Status is worked out in SQL once here, reused by every query in this file
// (list, single-license lookup, create, update) - two separate
// implementations of the same rule eventually disagree, and then the
// licence list and a single license's page show different things for the
// same row. 'near expire' has a space, not 'near_expire' - keep it that way
// everywhere this value is compared against. Parameterized on the column
// reference (a bare name for a plain findAll/findOne on SoftwareLicense
// itself, an aliased one like 'license.date_expire' when read through an
// include) rather than duplicated per call site, so it's still one rule, not
// several that can quietly drift apart.
function statusCaseSql(licenseTypeCol, dateExpireCol) {
  return `
      CASE
        WHEN ${licenseTypeCol} IN ('Free', 'Perpetual') THEN 'active'
        WHEN ${licenseTypeCol} = 'Annual Subscription' THEN
          CASE
            WHEN ${dateExpireCol} IS NULL THEN 'unknown'
            WHEN ${dateExpireCol} < CAST(GETDATE() AS DATE) THEN 'expired'
            WHEN ${dateExpireCol} <= DATEADD(MONTH, 1, CAST(GETDATE() AS DATE)) THEN 'near expire'
            ELSE 'active'
          END
        ELSE 'unknown'
      END`;
}

// The DB server's own clock, not a JS Date() - matches partBorrowModel.js's
// own justified today's-date fetch (no table involved at all, so there is
// nothing for an ORM model to read this through) rather than risking a
// timezone/clock-skew mismatch between this app server and the database.
async function getServerToday(transaction) {
  const [{ today }] = await sequelize.query(
    'SELECT CAST(GETDATE() AS DATE) AS today', { type: QueryTypes.SELECT, transaction },
  );
  return today; // 'YYYY-MM-DD'
}

// SQL Server's DATEADD(MONTH, 1, ...) clamps to the target month's last real
// day (Jan 31 + 1 month -> Feb 28, not a rolled-forward Mar 3) - Date.UTC()
// does NOT do this on its own (an out-of-range day rolls into the next
// month instead), so the day-of-month has to be clamped explicitly first to
// match. Confirmed live against the DB: without this clamp, today=2026-08-31
// gave JS '2026-10-01' vs SQL's '2026-09-30'.
function addMonthsToIsoDate(isoDate, months) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const targetIndex = (y * 12 + (m - 1)) + months;
  const targetYear = Math.floor(targetIndex / 12);
  const targetMonth0 = ((targetIndex % 12) + 12) % 12; // 0-based, always non-negative
  const lastDayOfTargetMonth = new Date(Date.UTC(targetYear, targetMonth0 + 1, 0)).getUTCDate();
  return new Date(Date.UTC(targetYear, targetMonth0, Math.min(d, lastDayOfTargetMonth))).toISOString().slice(0, 10);
}

// JS mirror of statusCaseSql() above, for createLicense()/updateLicense()
// below - one rule expressed twice (SQL for reads, JS for these two writes)
// rather than the three separate copies the original had (statusCaseSql()
// for reads, plus a duplicated inline CASE in each of createLicense's INSERT
// and updateLicense's UPDATE). `today` must be a 'YYYY-MM-DD' string from
// getServerToday() above, compared lexicographically exactly the way SQL
// Server's own DATE comparison would (ISO dates sort the same both ways).
function computeStatus(licenseType, dateExpire, today) {
  if (licenseType === 'Free' || licenseType === 'Perpetual') return 'active';
  if (licenseType === 'Annual Subscription') {
    if (!dateExpire) return 'unknown';
    if (dateExpire < today) return 'expired';
    if (dateExpire <= addMonthsToIsoDate(today, 1)) return 'near expire';
    return 'active';
  }
  return 'unknown';
}

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
  const rows = await SoftwareLicense.findAll({
    attributes: [
      'license_id', 'product_name', 'product_type', 'license_type', 'date_start', 'date_expire', 'remark',
      [sequelize.literal(statusCaseSql('license_type', 'date_expire')), 'status'],
      [sequelize.fn('COUNT', sequelize.col('installs.equipment_id')), 'install_count'],
    ],
    include: [{ model: EquipmentSoftwareLicense, as: 'installs', attributes: [] }],
    group: [
      'SoftwareLicense.license_id', 'SoftwareLicense.product_name', 'SoftwareLicense.product_type',
      'SoftwareLicense.license_type', 'SoftwareLicense.date_start', 'SoftwareLicense.date_expire',
      'SoftwareLicense.remark',
    ],
    order: [['product_name', 'ASC']],
    subQuery: false,
    raw: true,
  });
  return rows.map(fixDates);
}

// All licences on one device. Returns an array - a laptop may have Office and
// Adobe and an antivirus product at once.
async function getEquipmentLicenses(equipmentId) {
  const rows = await EquipmentSoftwareLicense.findAll({
    where: { equipment_id: equipmentId },
    include: [{
      model: SoftwareLicense, as: 'license', required: true,
      attributes: [
        'license_id', 'product_name', 'product_type', 'license_type', 'date_start', 'date_expire', 'remark',
        [sequelize.literal(statusCaseSql('license.license_type', 'license.date_expire')), 'status'],
      ],
    }],
    order: [[{ model: SoftwareLicense, as: 'license' }, 'product_name', 'ASC']],
  });
  return rows.map((row) => {
    const { license, ...l } = row.get({ plain: true });
    return fixDates({
      license_id: license.license_id,
      product_name: license.product_name,
      product_type: license.product_type,
      license_type: license.license_type,
      date_start: license.date_start,
      date_expire: license.date_expire,
      remark: license.remark,
      status: license.status,
      installed_date: l.installed_date,
      install_remark: l.remark,
    });
  });
}

// The reverse: which devices a licence is installed on. Answers "we have 50
// seats - how many are used, and by whom?"
async function getLicenseEquipment(licenseId) {
  const rows = await EquipmentSoftwareLicense.findAll({
    where: { license_id: licenseId },
    include: [{
      model: Equipment, as: 'equipment', required: true,
      include: [{ model: Category, as: 'category' }, { model: Employee, as: 'owner' }],
    }],
    order: [
      [{ model: Equipment, as: 'equipment' }, 'device_name', 'ASC'],
      [{ model: Equipment, as: 'equipment' }, 'computer_name', 'ASC'],
    ],
  });
  return rows.map((row) => {
    const { equipment, ...l } = row.get({ plain: true });
    return fixDates({
      equipment_id: equipment.equipment_id,
      device_name: equipment.device_name,
      computer_name: equipment.computer_name,
      device_model: equipment.device_model,
      asset_code: equipment.asset_code,
      equipment_status: equipment.status,
      category_name: equipment.category ? equipment.category.category_name : null,
      owner_name: equipment.owner ? equipment.owner.full_name : null,
      installed_date: l.installed_date,
      install_remark: l.remark,
    });
  });
}

// Adds a licence to a device, leaving any others in place.
//
// Assigning the same licence twice updates the install date instead of
// failing on the primary key - a frontend that re-submits a form should not
// produce an error. The MERGE's COALESCE-per-field UPDATE branch (keep
// whatever wasn't supplied) is an explicit lookup chain here instead - same
// pattern as customFieldModel.setValues() and its siblings elsewhere in
// this migration - rather than Sequelize's upsert() (which would overwrite
// rather than merge).
async function assignLicenseToEquipment(equipmentId, licenseId, { installedDate, remark } = {}) {
  const existing = await EquipmentSoftwareLicense.findOne({
    where: { equipment_id: equipmentId, license_id: licenseId },
  });

  if (existing) {
    const values = {};
    if (installedDate) values.installed_date = installedDate;
    if (remark) values.remark = remark;
    if (Object.keys(values).length > 0) await existing.update(values);
  } else {
    await EquipmentSoftwareLicense.create({
      equipment_id: equipmentId,
      license_id: licenseId,
      installed_date: installedDate || null,
      remark: remark || null,
    });
  }

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

  const rows = await EquipmentSoftwareLicense.findAll({
    where: { equipment_id: { [Op.in]: equipmentIds } },
    attributes: ['equipment_id'],
    include: [{
      model: SoftwareLicense, as: 'license', required: true,
      attributes: [
        'license_id', 'product_name', 'license_type', 'date_start', 'date_expire',
        [sequelize.literal(statusCaseSql('license.license_type', 'license.date_expire')), 'status'],
      ],
    }],
    order: [[{ model: SoftwareLicense, as: 'license' }, 'product_name', 'ASC']],
  });

  const byEquipment = {};
  for (const row of rows) {
    const { license, equipment_id } = row.get({ plain: true });
    const shaped = fixDates({
      equipment_id,
      license_id: license.license_id,
      product_name: license.product_name,
      license_type: license.license_type,
      date_start: license.date_start,
      date_expire: license.date_expire,
      status: license.status,
    });
    if (!byEquipment[equipment_id]) byEquipment[equipment_id] = [];
    byEquipment[equipment_id].push(shaped);
  }
  return byEquipment;
}

async function findLicenseById(licenseId) {
  const row = await SoftwareLicense.findOne({
    where: { license_id: licenseId },
    attributes: [
      'license_id', 'product_name', 'product_type', 'date_expire', 'status', 'remark', 'date_start', 'license_type',
      [sequelize.literal(statusCaseSql('license_type', 'date_expire')), 'calculated_status'],
    ],
    raw: true,
  });
  return fixDates(row) || null;
}

// --- license definitions (create/edit/delete the product itself, as
// opposed to assigning an existing one to a device, above) ---

// license_type is required: 'Free', 'Annual Subscription', or 'Perpetual'.
// For 'Free' and 'Perpetual', status is always 'active'; for 'Annual
// Subscription' it's calculated from date_start/date_expire via the same
// STATUS_CASE every other query here uses, so this can never disagree with
// what the license list shows for the same row.
//
// status is computed via computeStatus() above (the same rule statusCaseSql()
// expresses in SQL for every read in this file) against the DB server's own
// clock (getServerToday()), not a JS Date() - see the comments on both.
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

  const today = await getServerToday();
  const row = await SoftwareLicense.create({
    product_name,
    product_type: product_type || null,
    license_type,
    date_start: date_start || null,
    date_expire: date_expire || null,
    status: computeStatus(license_type, date_expire || null, today),
    remark: remark || null,
  });
  const plain = row.get({ plain: true });
  // The original OUTPUT INSERTED column list was an explicit subset in a
  // specific order, not INSERTED.* - reconstructed here rather than relying
  // on either physical-column order or .create()'s own key order.
  return fixDates({
    license_id: plain.license_id,
    product_name: plain.product_name,
    product_type: plain.product_type,
    license_type: plain.license_type,
    date_start: plain.date_start,
    date_expire: plain.date_expire,
    remark: plain.remark,
    status: plain.status,
  });
}

// Partial update - COALESCE keeps existing values for anything not supplied.
// Status is always recomputed from license_type and dates, never set
// directly, via computeStatus() (see createLicense() above for why).
async function updateLicense(id, data) {
  const existing = await SoftwareLicense.findByPk(id, { raw: true });
  if (!existing) return null;

  const resulting = {
    product_name: data.product_name || existing.product_name,
    product_type: data.product_type || existing.product_type,
    license_type: data.license_type || existing.license_type,
    date_start: data.date_start || existing.date_start,
    date_expire: data.date_expire || existing.date_expire,
    remark: data.remark || existing.remark,
  };

  const today = await getServerToday();
  const [, rows] = await SoftwareLicense.update(
    { ...resulting, status: computeStatus(resulting.license_type, resulting.date_expire, today) },
    { where: { license_id: id }, returning: true },
  );
  const plain = rows && rows[0] ? rows[0].get({ plain: true }) : null;
  if (!plain) return null;
  // Same explicit OUTPUT-column-list reconstruction as createLicense() above.
  return fixDates({
    license_id: plain.license_id,
    product_name: plain.product_name,
    product_type: plain.product_type,
    license_type: plain.license_type,
    date_start: plain.date_start,
    date_expire: plain.date_expire,
    remark: plain.remark,
    status: plain.status,
  });
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
    const row = await SoftwareLicense.findByPk(id, { transaction, raw: true });
    if (!row) return null;
    const license = fixDates(row);

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

    await SoftwareLicense.destroy({ where: { license_id: id }, transaction });

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
