const serverUsageModel = require('../models/serverUsageModel');
const equipmentModel = require('../models/equipmentModel');

// GET /api/server-usage                          - today's view: one row
//   per server, its latest entry ever.
// GET /api/server-usage?from=...&to=...           - the calendar/history
//   view: every entry actually recorded in that range, so a server edited
//   twice in the window shows up twice, and one untouched in the window
//   doesn't show up at all. Genuinely different from the plain view, not
//   the same query with a filter bolted on.
async function getServerUsage(req, res, next) {
  try {
    const { from, to } = req.query;
    const usage = (from || to)
      ? await serverUsageModel.getServerUsageHistory(from, to)
      : await serverUsageModel.getServerUsage();
    res.json(usage);
  } catch (err) {
    next(err);
  }
}

// POST /api/server-usage  (admin)
// Sets capacity/usage/platform for one equipment - upserts, so this doubles
// as both "record it for the first time" and "correct what's there".
async function setServerUsage(req, res, next) {
  const { equipment_id, cpu_core_total, memory_gb_total, hdd_gb_total, owner_id } = req.body;
  if (!equipment_id) {
    return res.status(400).json({
      error: 'equipment_id is required',
      example: { equipment_id: 30, cpu_core_total: 8, memory_gb_total: 32, cpu_usage_pct: '60%' },
    });
  }
  try {
    const equipment = await equipmentModel.findById(equipment_id);
    if (!equipment) return res.status(404).json({ error: 'Equipment not found' });

    // Total Capacity is equipment.cpu/ram/hd and Owner is equipment.owner_id -
    // neither is a separate server_usage column, so editing them from this
    // side writes back to the one real value instead of a copy, the same as
    // editing them from the Server form does.
    if (cpu_core_total !== undefined || memory_gb_total !== undefined || hdd_gb_total !== undefined) {
      await equipmentModel.update(equipment_id, {
        cpu: cpu_core_total !== undefined ? String(cpu_core_total) : undefined,
        ram: memory_gb_total !== undefined ? String(memory_gb_total) : undefined,
        hd: hdd_gb_total !== undefined ? String(hdd_gb_total) : undefined,
      });
    }
    if (owner_id !== undefined) {
      await equipmentModel.updateOwner(equipment_id, owner_id);
    }

    const usage = await serverUsageModel.upsertServerUsage(equipment_id, req.body);
    res.status(201).json({ message: 'Server usage saved', usage });
  } catch (err) {
    next(err);
  }
}

async function removeServerUsage(req, res, next) {
  try {
    const usage = await serverUsageModel.removeServerUsage(req.params.id);
    if (!usage) return res.status(404).json({ error: 'Server usage record not found' });
    res.json({ message: 'Server usage record removed', usage });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/server-usage/equipment/:id/usage  (any signed-in user)
// The self-service form: cpu/memory/hdd usage only, keyed by equipment_id
// (not usage_id - a user looking at a server knows its equipment_id, not
// an internal server_usage row id they'd have no way to know). Creates the
// row if this equipment has never had one, same as setServerUsage's own
// upsert - only 36 of 521 equipment currently have a row, so requiring one
// to already exist would block almost every real attempt to use this form.
// Everything else (capacity, due date, owner, remark) stays admin-only
// through setServerUsage above: reusing upsertServerUsage() here but only
// ever forwarding these three named fields, regardless of what else the
// caller's body contains, is what keeps that boundary - not validation.
async function updateUsage(req, res, next) {
  const { cpu_usage_pct, memory_usage_pct, hdd_usage_gb } = req.body;
  try {
    const equipment = await equipmentModel.findById(req.params.id);
    if (!equipment) return res.status(404).json({ error: 'Equipment not found' });

    const usage = await serverUsageModel.upsertServerUsage(req.params.id, {
      cpu_usage_pct, memory_usage_pct, hdd_usage_gb,
    });
    res.json({ message: 'Usage saved', usage });
  } catch (err) {
    next(err);
  }
}

module.exports = { getServerUsage, setServerUsage, updateUsage, removeServerUsage };
