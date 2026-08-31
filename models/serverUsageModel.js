const { DataTypes } = require('sequelize');
const sequelize = require('../config/sequelize');
const { QueryTypes } = require('sequelize');
const { Equipment } = require('./equipmentModel');
const { Employee } = require('./employeeModel');
const { Category } = require('./categoryModel');

// The capacity-planning calculation sheet ("Plan optimize"): Total Capacity
// vs Usage, one row per server. This is deliberately separate from "server"
// (dbo.equipment) - that stores what a server is, this calculates what to do
// about its capacity. Name, IP, Owner AND Total Capacity are not duplicated
// here; they come from dbo.equipment (cpu/ram/hd is the same fact as Total
// Capacity, so there's no separate column to keep in sync - editing either
// side edits the one real value). TRY_CAST rather than CAST: a non-numeric
// cpu/ram/hd (free text like "Core i5") should show up here as blank, not
// break the whole query.
//
// plan_date and the reducing/after-reducing columns were dropped - no
// longer tracked here.
//
// Not required by equipmentModel.js, so (like borrowModel.js/
// softwareLicenseModel.js) it's safe for this file to import Equipment and
// build an association onto it.
const ServerUsage = sequelize.define('ServerUsage', {
  usage_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  equipment_id: { type: DataTypes.INTEGER, allowNull: false },
  cpu_usage_pct: { type: DataTypes.STRING(10), allowNull: true },
  memory_usage_pct: { type: DataTypes.STRING(10), allowNull: true },
  hdd_usage_gb: { type: DataTypes.DECIMAL, allowNull: true },
  remark: { type: DataTypes.STRING(255), allowNull: true },
  due_date: { type: DataTypes.DATEONLY, allowNull: true },
}, {
  tableName: 'server_usage',
  schema: 'dbo',
  timestamps: false,
});

ServerUsage.belongsTo(Equipment, { foreignKey: 'equipment_id', as: 'equipment' });
// Reverse direction for getServerUsage() below - lets the list start from
// every Server-category equipment and LEFT JOIN outward to its usage row
// (or lack of one), rather than starting from server_usage and only ever
// showing equipment that already has a row.
Equipment.hasOne(ServerUsage, { foreignKey: 'equipment_id', as: 'usage' });

// upsertServerUsage's MERGE with COALESCE-per-field doesn't map onto
// Sequelize's upsert() (which would null out any field left unprovided,
// not keep the existing value), so that one stays a raw query.

const DATE_FIELDS = ['due_date'];

// "5" (typed without a % sign, from either the admin form or the
// self-service one) becomes "5%" - so the value is always usable
// consistently wherever it's displayed, regardless of whether the caller
// remembered to type the sign. Already-suffixed ("5%") and blank/null
// values pass through unchanged - never double up to "5%%".
function normalizePercent(value) {
  if (value === null || value === undefined) return value;
  const str = String(value).trim();
  if (str === '' || str.endsWith('%')) return str;
  return `${str}%`;
}

// Raw queries with no model attribute definition return a plain
// 'YYYY-MM-DD' string for a DATE column; the driver this replaces returned
// a Date object for the same column. Converting back keeps every response
// identical to before this migration.
function fixDates(row) {
  if (!row) return row;
  for (const f of DATE_FIELDS) {
    if (row[f]) row[f] = new Date(row[f]);
  }
  return row;
}

// Every Server-category equipment, not just the ones that already have a
// server_usage row - a server nobody has filled usage in for yet still
// needs to show up here (with blank usage fields) so there's somewhere to
// find it and fill it in, rather than only listing what already exists.
async function getServerUsage() {
  const rows = await Equipment.findAll({
    where: { '$category.category_name$': 'Server' },
    attributes: [
      'equipment_id', 'device_name', 'ip_address', 'owner_id',
      [sequelize.literal('TRY_CAST(cpu AS INT)'), 'cpu_core_total'],
      [sequelize.literal('TRY_CAST(ram AS INT)'), 'memory_gb_total'],
      [sequelize.literal('TRY_CAST(hd AS INT)'), 'hdd_gb_total'],
    ],
    include: [
      { model: Category, as: 'category', attributes: [] },
      { model: Employee, as: 'owner', attributes: ['full_name'], required: false },
      { model: ServerUsage, as: 'usage', required: false },
    ],
    order: [['device_name', 'ASC'], ['equipment_id', 'ASC']],
  });

  return rows.map((row) => {
    const { owner, usage, ...e } = row.get({ plain: true });
    return fixDates({
      usage_id: usage ? usage.usage_id : null,
      equipment_id: e.equipment_id,
      device_name: e.device_name,
      ip_address: e.ip_address,
      owner_id: e.owner_id,
      owner_name: owner ? owner.full_name : null,
      due_date: usage ? usage.due_date : null,
      cpu_core_total: e.cpu_core_total,
      memory_gb_total: e.memory_gb_total,
      hdd_gb_total: e.hdd_gb_total,
      cpu_usage_pct: usage ? usage.cpu_usage_pct : null,
      memory_usage_pct: usage ? usage.memory_usage_pct : null,
      hdd_usage_gb: usage ? usage.hdd_usage_gb : null,
      remark: usage ? usage.remark : null,
    });
  });
}

// Sets the calculation fields for one equipment - MERGE so an
// admin filling this in doesn't need to know whether a row already exists
// for that server, the same way part_stock's increment() spares the caller
// from that. COALESCE keeps a field already recorded when this update
// leaves it out, rather than blanking it back to null.
//
// due_date is no longer something a caller sets - it's "last recorded",
// stamped to today automatically whenever any usage field
// (cpu_usage_pct/memory_usage_pct/hdd_usage_gb) is actually supplied,
// whether that's the admin's own form or the self-service one. A caller
// can no longer set it directly; a due_date-only call (nothing else
// supplied) leaves it exactly as it was, same as any other field nobody
// touched. CAST(GETDATE() AS DATE) rather than a JS Date, so it's the
// server's own clock, not something formatted client-side.
async function upsertServerUsage(equipmentId, d) {
  const usageTouched = d.cpu_usage_pct !== undefined || d.memory_usage_pct !== undefined || d.hdd_usage_gb !== undefined;

  const [row] = await sequelize.query(`
      MERGE dbo.server_usage AS target
      USING (SELECT :equipment_id AS equipment_id) AS source
      ON target.equipment_id = source.equipment_id
      WHEN MATCHED THEN UPDATE SET
        due_date = CASE WHEN :usage_touched = 1 THEN CAST(GETDATE() AS DATE) ELSE due_date END,
        cpu_usage_pct = COALESCE(:cpu_usage_pct, cpu_usage_pct),
        memory_usage_pct = COALESCE(:memory_usage_pct, memory_usage_pct),
        hdd_usage_gb = COALESCE(:hdd_usage_gb, hdd_usage_gb),
        remark = COALESCE(:remark, remark)
      WHEN NOT MATCHED THEN INSERT (
        equipment_id, due_date,
        cpu_usage_pct, memory_usage_pct, hdd_usage_gb, remark
      ) VALUES (
        :equipment_id, CASE WHEN :usage_touched = 1 THEN CAST(GETDATE() AS DATE) ELSE NULL END,
        :cpu_usage_pct, :memory_usage_pct, :hdd_usage_gb, :remark
      )
      OUTPUT INSERTED.*;
  `, {
    replacements: {
      equipment_id: equipmentId,
      usage_touched: usageTouched ? 1 : 0,
      cpu_usage_pct: normalizePercent(d.cpu_usage_pct) ?? null,
      memory_usage_pct: normalizePercent(d.memory_usage_pct) ?? null,
      hdd_usage_gb: d.hdd_usage_gb ?? null,
      remark: d.remark ?? null,
    },
    type: QueryTypes.SELECT,
  });
  return fixDates(row);
}

// Sequelize's destroy() doesn't return the deleted row - fetch first so the
// caller still gets back what was removed.
async function removeServerUsage(usageId) {
  const row = await ServerUsage.findByPk(usageId, { raw: true });
  if (!row) return null;
  await ServerUsage.destroy({ where: { usage_id: usageId } });
  return fixDates(row);
}

module.exports = { getServerUsage, upsertServerUsage, removeServerUsage };
