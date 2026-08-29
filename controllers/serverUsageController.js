const serverUsageModel = require('../models/serverUsageModel');
const equipmentModel = require('../models/equipmentModel');

// GET /api/server-usage
async function getServerUsage(req, res, next) {
  try {
    res.json(await serverUsageModel.getServerUsage());
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
      example: { equipment_id: 30, cpu_core_total: 8, memory_gb_total: 32, reducing_cpu_core: 2 },
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

module.exports = { getServerUsage, setServerUsage, removeServerUsage };
