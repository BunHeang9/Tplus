const { DataTypes } = require('sequelize');
const sequelize = require('../config/sequelize');
const { Equipment } = require('./equipmentModel');
const { Employee } = require('./employeeModel');

// Antivirus rollout tracking (dbo.antivirus_install) - plan/due/completed
// dates and status per install attempt on a device.

const AntivirusInstall = sequelize.define('AntivirusInstall', {
  install_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  equipment_id: { type: DataTypes.INTEGER, allowNull: false },
  antivirus_status: { type: DataTypes.STRING(30), allowNull: true },
  windows_server_license: { type: DataTypes.BOOLEAN, allowNull: true },
  // DATEONLY, not DATE - these are SQL DATE columns (no time component).
  // Sequelize returns DATEONLY as a plain 'YYYY-MM-DD' string, unlike the
  // raw mssql driver which returns a Date object for the same SQL type -
  // fixDates() below converts it back after every read to keep the API
  // response identical to what it was before this migration.
  plan_date: { type: DataTypes.DATEONLY, allowNull: true },
  due_date: { type: DataTypes.DATEONLY, allowNull: true },
  completed_date: { type: DataTypes.DATEONLY, allowNull: true },
  remark: { type: DataTypes.STRING(255), allowNull: true },
}, {
  tableName: 'antivirus_install',
  schema: 'dbo',
  timestamps: false,
});

AntivirusInstall.belongsTo(Equipment, { foreignKey: 'equipment_id', as: 'equipment' });

const DATE_FIELDS = ['plan_date', 'due_date', 'completed_date'];

// Sequelize's DATEONLY returns 'YYYY-MM-DD' strings; the raw driver this
// replaces returned Date objects for the same SQL DATE columns. Converting
// back keeps every response identical to before this migration.
function fixDates(row) {
  if (!row) return row;
  for (const f of DATE_FIELDS) {
    if (row[f]) row[f] = new Date(row[f]);
  }
  return row;
}

// A device can be reinstalled more than once, so this always adds a new
// row rather than merging into an existing one the way server_usage does -
// each install attempt is its own record, not a single fact being corrected.
async function createAntivirusInstall(d) {
  const row = await AntivirusInstall.create({
    equipment_id: d.equipment_id,
    antivirus_status: d.antivirus_status ?? null,
    windows_server_license: d.windows_server_license ?? null,
    plan_date: d.plan_date ?? null,
    due_date: d.due_date ?? null,
    completed_date: d.completed_date ?? null,
    remark: d.remark ?? null,
  });
  return fixDates(row.get({ plain: true }));
}

async function updateAntivirusInstall(installId, d) {
  // The original COALESCE(@x, existing) treats an explicit null the same as
  // "don't touch this field" - there was never a way to null out a field
  // through this update, only skip it or set a real value. Matching that:
  // null and undefined are both skipped here, not just undefined.
  const values = {};
  for (const key of ['antivirus_status', 'windows_server_license', 'plan_date', 'due_date', 'completed_date', 'remark']) {
    if (d[key] !== undefined && d[key] !== null) values[key] = d[key];
  }
  if (Object.keys(values).length === 0) {
    const row = await AntivirusInstall.findByPk(installId, { raw: true });
    return fixDates(row);
  }

  const [, [row]] = await AntivirusInstall.update(values, {
    where: { install_id: installId },
    returning: true,
  });
  return row ? fixDates(row.get({ plain: true })) : null;
}

// Sequelize's destroy() doesn't return the deleted row - fetch first so the
// caller still gets back what was removed.
async function removeAntivirusInstall(installId) {
  const row = await AntivirusInstall.findByPk(installId, { raw: true });
  if (!row) return null;
  await AntivirusInstall.destroy({ where: { install_id: installId } });
  return fixDates(row);
}

async function getAntivirus() {
  const rows = await AntivirusInstall.findAll({
    include: [{ model: Equipment, as: 'equipment', include: [{ model: Employee, as: 'owner' }] }],
    order: [['install_id', 'ASC']],
  });
  return rows.map((row) => {
    const { equipment, install_id, equipment_id, ...ownFields } = row.get({ plain: true });
    const owner = equipment && equipment.owner;
    return fixDates({
      install_id,
      equipment_id,
      computer_name: equipment ? equipment.computer_name : null,
      device_model: equipment ? equipment.device_model : null,
      asset_code: equipment ? equipment.asset_code : null,
      owner_name: owner ? owner.full_name : null,
      ...ownFields,
    });
  });
}

module.exports = {
  getAntivirus,
  createAntivirusInstall,
  updateAntivirusInstall,
  removeAntivirusInstall,
};
