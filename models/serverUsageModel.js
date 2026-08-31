const sequelize = require('../config/sequelize');
const { QueryTypes } = require('sequelize');

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
// upsertServerUsage's MERGE with COALESCE-per-field doesn't map onto
// Sequelize's upsert() (which would null out any field left unprovided,
// not keep the existing value) - raw queries throughout this file rather
// than a half-ORM, half-raw model for the sake of consistency.

const DATE_FIELDS = ['due_date'];

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

async function getServerUsage() {
  const rows = await sequelize.query(`
    SELECT
      su.usage_id,
      su.equipment_id,
      e.device_name,
      e.ip_address,
      e.owner_id,
      emp.full_name AS owner_name,
      su.due_date,
      TRY_CAST(e.cpu AS INT) AS cpu_core_total,
      TRY_CAST(e.ram AS INT) AS memory_gb_total,
      TRY_CAST(e.hd  AS INT) AS hdd_gb_total,
      su.cpu_usage_pct,
      su.memory_usage_pct,
      su.hdd_usage_gb,
      su.remark
    FROM dbo.server_usage su
    LEFT JOIN dbo.equipment e   ON su.equipment_id = e.equipment_id
    LEFT JOIN dbo.employee emp  ON e.owner_id = emp.employee_id
    ORDER BY e.device_name, su.usage_id
  `, { type: QueryTypes.SELECT });
  return rows.map(fixDates);
}

// Sets the calculation fields for one equipment - MERGE so an
// admin filling this in doesn't need to know whether a row already exists
// for that server, the same way part_stock's increment() spares the caller
// from that. COALESCE keeps a field already recorded when this update
// leaves it out, rather than blanking it back to null.
async function upsertServerUsage(equipmentId, d) {
  const [row] = await sequelize.query(`
      MERGE dbo.server_usage AS target
      USING (SELECT :equipment_id AS equipment_id) AS source
      ON target.equipment_id = source.equipment_id
      WHEN MATCHED THEN UPDATE SET
        due_date = COALESCE(:due_date, due_date),
        cpu_usage_pct = COALESCE(:cpu_usage_pct, cpu_usage_pct),
        memory_usage_pct = COALESCE(:memory_usage_pct, memory_usage_pct),
        hdd_usage_gb = COALESCE(:hdd_usage_gb, hdd_usage_gb),
        remark = COALESCE(:remark, remark)
      WHEN NOT MATCHED THEN INSERT (
        equipment_id, due_date,
        cpu_usage_pct, memory_usage_pct, hdd_usage_gb, remark
      ) VALUES (
        :equipment_id, :due_date,
        :cpu_usage_pct, :memory_usage_pct, :hdd_usage_gb, :remark
      )
      OUTPUT INSERTED.*;
  `, {
    replacements: {
      equipment_id: equipmentId,
      due_date: d.due_date ?? null,
      cpu_usage_pct: d.cpu_usage_pct ?? null,
      memory_usage_pct: d.memory_usage_pct ?? null,
      hdd_usage_gb: d.hdd_usage_gb ?? null,
      remark: d.remark ?? null,
    },
    type: QueryTypes.SELECT,
  });
  return fixDates(row);
}

async function removeServerUsage(usageId) {
  const [row] = await sequelize.query(
    'DELETE FROM dbo.server_usage OUTPUT DELETED.* WHERE usage_id = :id',
    { replacements: { id: usageId }, type: QueryTypes.SELECT },
  );
  return fixDates(row) || null;
}

module.exports = { getServerUsage, upsertServerUsage, removeServerUsage };
