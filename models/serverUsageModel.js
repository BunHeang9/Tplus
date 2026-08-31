const { DataTypes } = require('sequelize');
const sequelize = require('../config/sequelize');
const { QueryTypes } = require('sequelize');
const { Equipment } = require('./equipmentModel');

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
// top-1-per-group query, not the "business rule guarantees at most one"
// shortcut used elsewhere in this migration - no clean Sequelize include
// expresses that, so this stays raw SQL (OUTER APPLY TOP 1), same
// reasoning already applied to borrowModel.findAvailableToBorrow's NOT
// EXISTS, viewColumnModel listViews()'s item_count, etc.
async function getServerUsage() {
  const rows = await sequelize.query(`
    SELECT e.equipment_id, e.device_name, e.ip_address, e.owner_id,
           emp.full_name AS owner_name,
           su.usage_id, su.due_date,
           TRY_CAST(e.cpu AS INT) AS cpu_core_total,
           TRY_CAST(e.ram AS INT) AS memory_gb_total,
           TRY_CAST(e.hd  AS INT) AS hdd_gb_total,
           su.cpu_usage_pct, su.memory_usage_pct, su.hdd_usage_gb, su.remark
    FROM dbo.equipment e
    JOIN dbo.category c   ON e.category_id = c.category_id AND c.category_name = 'Server'
    LEFT JOIN dbo.employee emp ON e.owner_id = emp.employee_id
    OUTER APPLY (
      SELECT TOP 1 s.usage_id, s.due_date, s.cpu_usage_pct, s.memory_usage_pct, s.hdd_usage_gb, s.remark
      FROM dbo.server_usage s
      WHERE s.equipment_id = e.equipment_id
      ORDER BY s.due_date DESC, s.usage_id DESC
    ) su
    ORDER BY e.device_name, e.equipment_id
  `, { type: QueryTypes.SELECT });
  return rows.map(fixDates);
}

// The calendar/history view: every entry actually recorded within
// [from, to] - if a server was edited twice in the window, both entries
// come back, not just the latest one squashed down to a single row. A
// server untouched during the window simply doesn't appear at all here -
// unlike getServerUsage() above, this isn't "every server, blank or not",
// it's a log of what happened, so nothing happening means nothing to show.
async function getServerUsageHistory(from, to) {
  const rows = await sequelize.query(`
    SELECT su.usage_id, e.equipment_id, e.device_name, e.ip_address, e.owner_id,
           emp.full_name AS owner_name,
           su.due_date,
           TRY_CAST(e.cpu AS INT) AS cpu_core_total,
           TRY_CAST(e.ram AS INT) AS memory_gb_total,
           TRY_CAST(e.hd  AS INT) AS hdd_gb_total,
           su.cpu_usage_pct, su.memory_usage_pct, su.hdd_usage_gb, su.remark
    FROM dbo.server_usage su
    JOIN dbo.equipment e ON su.equipment_id = e.equipment_id
    JOIN dbo.category c  ON e.category_id = c.category_id AND c.category_name = 'Server'
    LEFT JOIN dbo.employee emp ON e.owner_id = emp.employee_id
    WHERE (:from IS NULL OR su.due_date >= :from)
      AND (:to   IS NULL OR su.due_date <= :to)
    ORDER BY su.due_date DESC, e.device_name ASC, su.usage_id DESC
  `, {
    replacements: { from: from || null, to: to || null },
    type: QueryTypes.SELECT,
  });
  return rows.map(fixDates);
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
  const [previous] = await sequelize.query(
    'SELECT TOP 1 * FROM dbo.server_usage WHERE equipment_id = :equipment_id ORDER BY due_date DESC, usage_id DESC',
    { replacements: { equipment_id: equipmentId }, type: QueryTypes.SELECT },
  );

  const [row] = await sequelize.query(`
      INSERT INTO dbo.server_usage (equipment_id, due_date, cpu_usage_pct, memory_usage_pct, hdd_usage_gb, remark)
      OUTPUT INSERTED.*
      VALUES (:equipment_id, CAST(GETDATE() AS DATE), :cpu_usage_pct, :memory_usage_pct, :hdd_usage_gb, :remark)
    `, {
    replacements: {
      equipment_id: equipmentId,
      cpu_usage_pct: normalizePercent(d.cpu_usage_pct) ?? (previous ? previous.cpu_usage_pct : null),
      memory_usage_pct: normalizePercent(d.memory_usage_pct) ?? (previous ? previous.memory_usage_pct : null),
      hdd_usage_gb: d.hdd_usage_gb ?? (previous ? previous.hdd_usage_gb : null),
      remark: d.remark ?? (previous ? previous.remark : null),
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

module.exports = {
  ServerUsage, // exported so equipmentModel.js can count references
  // against this same table definition (countReferences()) via a lazy
  // require, rather than a raw correlated subquery.
  getServerUsage, getServerUsageHistory, upsertServerUsage, removeServerUsage,
};
