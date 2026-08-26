const miscModel = require('../models/miscModel');
const equipmentModel = require('../models/equipmentModel');

// These endpoints are all "fetch and return" - a small helper keeps
// them from being eight near-identical try/catch blocks.
function simpleHandler(modelFn) {
  return async (req, res, next) => {
    try {
      const data = await modelFn();
      res.json(data);
    } catch (err) {
      next(err);
    }
  };
}

async function createLicense(req, res, next) {
  const { product_name, license_type } = req.body;

  if (!product_name) {
    return res.status(400).json({ error: "product_name is required" });
  }
  
  if (!license_type) {
    return res.status(400).json({
      error: "license_type is required",
      validValues: ["Free", "Annual Subscription", "Perpetual"],
    });
  }

  if (!["Free", "Annual Subscription", "Perpetual"].includes(license_type)) {
    return res.status(400).json({
      error:
        "license_type must be one of: Free, Annual Subscription, or Perpetual",
    });
  }

  if (license_type === "Annual Subscription" && !req.body.date_expire) {
    return res.status(400).json({
      error: "date_expire is required for Annual Subscription licenses",
      hint: "For Free and Perpetual licenses, date_expire can be null",
    });
  }

  if (req.body.status) {
    return res.status(400).json({
      error: "status cannot be set manually",
      hint: "Status is automatically calculated from license_type: Free/Perpetual = active, Annual Subscription = based on dates (pending, active, near expire, expired)",
    });
  }

  try {
    const license = await miscModel.createLicense(req.body);
    res.status(201).json({ message: "Software license created", license });
  } catch (err) {
    next(err);
  }
}

async function updateLicense(req, res, next) {
  if (req.body.status) {
    return res.status(400).json({
      error: "status cannot be set manually",
      hint: "Status is automatically recalculated based on license_type and dates",
    });
  }
    if (
      req.body.license_type &&
      !["Free", "Annual Subscription", "Perpetual"].includes(
        req.body.license_type,
      )
    ) {
      return res.status(400).json({
        error:
          "license_type must be one of: Free, Annual Subscription, or Perpetual",
      });
    }

  try {
    const license = await miscModel.updateLicense(req.params.id, req.body);
    if (!license) {
      return res.status(404).json({ error: "Software license not found" });
    }
    res.json({ message: "Software license updated", license });
  } catch (err) {
    next(err);
  }
}

async function removeLicense(req, res, next) {
  try {
    const license = await miscModel.removeLicense(req.params.id, req.user);
    if (!license) {
      return res.status(404).json({ error: "Software license not found" });
    }
    res.json({
      message: `Software license "${license.product_name}" moved to the recycle bin`,
      license,
    });
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

    const usage = await miscModel.upsertServerUsage(equipment_id, req.body);
    res.status(201).json({ message: 'Server usage saved', usage });
  } catch (err) {
    next(err);
  }
}

async function removeServerUsage(req, res, next) {
  try {
    const usage = await miscModel.removeServerUsage(req.params.id);
    if (!usage) return res.status(404).json({ error: 'Server usage record not found' });
    res.json({ message: 'Server usage record removed', usage });
  } catch (err) {
    next(err);
  }
}

// POST /api/antivirus  (admin)
async function createAntivirusInstall(req, res, next) {
  const { equipment_id } = req.body;
  if (!equipment_id) {
    return res.status(400).json({
      error: 'equipment_id is required',
      example: { equipment_id: 30, plan_date: '2026-08-01', antivirus_status: 'Pending' },
    });
  }
  try {
    const equipment = await equipmentModel.findById(equipment_id);
    if (!equipment) return res.status(404).json({ error: 'Equipment not found' });

    const install = await miscModel.createAntivirusInstall(req.body);
    res.status(201).json({ message: 'Antivirus install record created', install });
  } catch (err) {
    next(err);
  }
}

async function updateAntivirusInstall(req, res, next) {
  try {
    const install = await miscModel.updateAntivirusInstall(req.params.id, req.body);
    if (!install) return res.status(404).json({ error: 'Antivirus install record not found' });
    res.json({ message: 'Antivirus install record updated', install });
  } catch (err) {
    next(err);
  }
}

async function removeAntivirusInstall(req, res, next) {
  try {
    const install = await miscModel.removeAntivirusInstall(req.params.id);
    if (!install) return res.status(404).json({ error: 'Antivirus install record not found' });
    res.json({ message: 'Antivirus install record removed', install });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getSsdUpgrades: simpleHandler(miscModel.getSsdUpgrades),
  getSsdProcurement: simpleHandler(miscModel.getSsdProcurement),
  getLicenses: simpleHandler(miscModel.getLicenses),
  getServerUsage: simpleHandler(miscModel.getServerUsage),
  setServerUsage,
  removeServerUsage,
  getAntivirus: simpleHandler(miscModel.getAntivirus),
  createAntivirusInstall,
  updateAntivirusInstall,
  removeAntivirusInstall,
  getReplacements: simpleHandler(miscModel.getReplacements),
  getCloudRates: simpleHandler(miscModel.getCloudRates),
  getCloudUsage: simpleHandler(miscModel.getCloudUsage),
  createLicense: createLicense,
  updateLicense: updateLicense,
  removeLicense: removeLicense,
};
