const { DataTypes, Op, fn } = require('sequelize');
const sequelize = require('../config/sequelize');
const { Equipment } = require('./equipmentModel');
const { Category } = require('./categoryModel');
const { Employee } = require('./employeeModel');

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
// No reverse hasOne here - an equipment can have many server_usage rows now
// (see below), not one, so a plain association can't express "give me just
// the latest one, optionally within a date range" - getServerUsage() below
// is raw SQL for exactly that reason.

// server_usage is a history log, not one row per equipment: every save
// (admin or self-service) adds a new row rather than overwriting the
// existing one, so "what was this server's usage as of a given date"
// stays answerable later, not just "what is it right now". Same
// MERGE/COALESCE-doesn't-map-onto-the-ORM reasoning as before, now for a
// plain INSERT that still needs to look at the previous row to carry
// forward a field the caller didn't supply.

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

// JS mirror of SQL Server's TRY_CAST(x AS INT), confirmed live against real
// edge cases: whitespace trimmed, an optional leading +/- then digits only
// (a decimal point, unit suffix like "GB", or any other character makes it
// NULL - no prefix-parsing the way parseInt() alone would do), an empty or
// whitespace-only string is 0 (not NULL - a real TRY_CAST quirk), and a
// value outside INT's range is NULL (overflow), not a wrapped/truncated
// number.
function tryCastInt(value) {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  if (str === '') return 0;
  if (!/^[+-]?\d+$/.test(str)) return null;
  const n = parseInt(str, 10);
  return n > 2147483647 || n < -2147483648 ? null : n;
}

// Every Server-category equipment, not just the ones that already have a
// server_usage entry - a server nobody has filled usage in for yet still
// needs to show up here (with blank usage fields) so there's somewhere to
// find it and fill it in, rather than only listing what already exists.
// Always "right now": one row per server, its single latest entry ever -
// the calendar/history view is a separate function below, not this one
// with a date range bolted on, because they show fundamentally different
// things (current state vs. a log of what happened).
//
// Each equipment can now have many server_usage rows (a history log, not
// one row per server), so "just the latest one" needs a real
// top-1-per-group query. No clean Sequelize include expresses OUTER APPLY
// TOP 1 directly, but it reduces to the same "merge separate ORM reads in
// JS, keep the first-seen row per id" pattern employeeModel.
// searchWithEquipment() already uses for its own single-most-recent-
// antivirus-install fix: fetch every Server-category equipment, fetch every
// server_usage row already sorted latest-first, and take the first match
// per equipment_id in JS.
async function getServerUsage() {
  const equipmentRows = await Equipment.findAll({
    attributes: ['equipment_id', 'device_name', 'ip_address', 'owner_id', 'cpu', 'ram', 'hd'],
    include: [
      { model: Category, as: 'category', attributes: [], where: { category_name: 'Server' }, required: true },
      { model: Employee, as: 'owner', attributes: ['full_name'], required: false },
    ],
    order: [['device_name', 'ASC'], ['equipment_id', 'ASC']],
    subQuery: false,
  });

  const equipmentIds = equipmentRows.map((r) => r.equipment_id);
  const usageRows = equipmentIds.length > 0
    ? await ServerUsage.findAll({
      where: { equipment_id: { [Op.in]: equipmentIds } },
      attributes: ['equipment_id', 'usage_id', 'due_date', 'cpu_usage_pct', 'memory_usage_pct', 'hdd_usage_gb', 'remark'],
      order: [['due_date', 'DESC'], ['usage_id', 'DESC']],
      raw: true,
    })
    : [];
  const latestByEquipment = new Map();
  for (const row of usageRows) {
    if (!latestByEquipment.has(row.equipment_id)) latestByEquipment.set(row.equipment_id, row);
  }

  return equipmentRows.map((row) => {
    const { category, owner, ...e } = row.get({ plain: true });
    const su = latestByEquipment.get(e.equipment_id);
    return fixDates({
      equipment_id: e.equipment_id,
      device_name: e.device_name,
      ip_address: e.ip_address,
      owner_id: e.owner_id,
      owner_name: owner ? owner.full_name : null,
      usage_id: su ? su.usage_id : null,
      due_date: su ? su.due_date : null,
      cpu_core_total: tryCastInt(e.cpu),
      memory_gb_total: tryCastInt(e.ram),
      hdd_gb_total: tryCastInt(e.hd),
      cpu_usage_pct: su ? su.cpu_usage_pct : null,
      memory_usage_pct: su ? su.memory_usage_pct : null,
      hdd_usage_gb: su ? su.hdd_usage_gb : null,
      remark: su ? su.remark : null,
    });
  });
}

// The calendar/history view: every entry actually recorded within
// [from, to] - if a server was edited twice in the window, both entries
// come back, not just the latest one squashed down to a single row. A
// server untouched during the window simply doesn't appear at all here -
// unlike getServerUsage() above, this isn't "every server, blank or not",
// it's a log of what happened, so nothing happening means nothing to show.
async function getServerUsageHistory(from, to) {
  const where = {};
  if (from) where.due_date = { ...where.due_date, [Op.gte]: from };
  if (to) where.due_date = { ...where.due_date, [Op.lte]: to };

  const rows = await ServerUsage.findAll({
    where,
    include: [{
      model: Equipment, as: 'equipment', required: true,
      attributes: ['equipment_id', 'device_name', 'ip_address', 'owner_id', 'cpu', 'ram', 'hd'],
      include: [
        { model: Category, as: 'category', attributes: [], where: { category_name: 'Server' }, required: true },
        { model: Employee, as: 'owner', attributes: ['full_name'], required: false },
      ],
    }],
    order: [['due_date', 'DESC'], [{ model: Equipment, as: 'equipment' }, 'device_name', 'ASC'], ['usage_id', 'DESC']],
    subQuery: false,
  });

  return rows.map((row) => {
    const { equipment, ...su } = row.get({ plain: true });
    const { category, owner, ...e } = equipment;
    return fixDates({
      usage_id: su.usage_id,
      equipment_id: e.equipment_id,
      device_name: e.device_name,
      ip_address: e.ip_address,
      owner_id: e.owner_id,
      owner_name: owner ? owner.full_name : null,
      due_date: su.due_date,
      cpu_core_total: tryCastInt(e.cpu),
      memory_gb_total: tryCastInt(e.ram),
      hdd_gb_total: tryCastInt(e.hd),
      cpu_usage_pct: su.cpu_usage_pct,
      memory_usage_pct: su.memory_usage_pct,
      hdd_usage_gb: su.hdd_usage_gb,
      remark: su.remark,
    });
  });
}

// Adds a new usage entry for one equipment - never overwrites an existing
// row, so history stays intact ("history" being the whole point: your boss
// wants to pick a date range later and see what was recorded, not just the
// current numbers). A field left out of this call carries forward from the
// most recent prior entry (if any) rather than coming back blank, the same
// "don't lose what nobody touched" behaviour the old MERGE/COALESCE gave -
// just read from the last row instead of written onto it. due_date is
// always today (CAST(GETDATE() AS DATE), the server's own clock) - every
// save is its own dated entry now, not something that only moves when
// usage happens to be touched.
async function upsertServerUsage(equipmentId, d) {
  const previous = await ServerUsage.findOne({
    where: { equipment_id: equipmentId },
    order: [['due_date', 'DESC'], ['usage_id', 'DESC']],
    raw: true,
  });

  const row = await ServerUsage.create({
    equipment_id: equipmentId,
    // fn('GETDATE') rather than a JS Date, so the value is sent as a raw
    // SQL function call - SQL Server implicitly converts the DATETIME
    // result down to DATEONLY on insert, same result as the original's
    // explicit CAST(GETDATE() AS DATE) (confirmed live).
    due_date: fn('GETDATE'),
    cpu_usage_pct: normalizePercent(d.cpu_usage_pct) ?? (previous ? previous.cpu_usage_pct : null),
    memory_usage_pct: normalizePercent(d.memory_usage_pct) ?? (previous ? previous.memory_usage_pct : null),
    hdd_usage_gb: d.hdd_usage_gb ?? (previous ? previous.hdd_usage_gb : null),
    remark: d.remark ?? (previous ? previous.remark : null),
  });
  const plain = row.get({ plain: true });
  // Physical column order (confirmed against sys.columns): usage_id,
  // equipment_id, cpu_usage_pct, memory_usage_pct, hdd_usage_gb, remark,
  // due_date - reconstructed since .create()'s own key order doesn't
  // follow it (only a plain read does, see toPhysicalOrder() precedent
  // elsewhere in this migration).
  return fixDates({
    usage_id: plain.usage_id,
    equipment_id: plain.equipment_id,
    cpu_usage_pct: plain.cpu_usage_pct,
    memory_usage_pct: plain.memory_usage_pct,
    hdd_usage_gb: plain.hdd_usage_gb,
    remark: plain.remark,
    due_date: plain.due_date,
  });
}

// Sequelize's destroy() doesn't return the deleted row - fetch first so the
// caller still gets back what was removed.
async function removeServerUsage(usageId) {
  const row = await ServerUsage.findByPk(usageId, { raw: true });
  if (!row) return null;
  await ServerUsage.destroy({ where: { usage_id: usageId } });
  return fixDates(row);
}

module.exports = {
  ServerUsage, // exported so equipmentModel.js can count references
  // against this same table definition (countReferences()) via a lazy
  // require, rather than a raw correlated subquery.
  getServerUsage, getServerUsageHistory, upsertServerUsage, removeServerUsage,
};
