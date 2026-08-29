const softwareLicenseModel = require('../models/softwareLicenseModel');
const equipmentModel = require('../models/equipmentModel');

// Licence assignment. A device can hold several licences and a licence can
// cover several devices, so everything here works with lists.

// GET /api/equipment/licenses - the dropdown for the equipment form
async function getAllLicenses(req, res, next) {
  try {
    const licenses = await softwareLicenseModel.getAllLicenses();
    res.json({ count: licenses.length, licenses });
  } catch (err) {
    next(err);
  }
}

// GET /api/licenses - the license admin list. A bare array, unlike
// getAllLicenses above - different callers, different shape, both already
// relied on by whatever's consuming them today.
async function getLicenses(req, res, next) {
  try {
    res.json(await softwareLicenseModel.getAllLicenses());
  } catch (err) {
    next(err);
  }
}

// GET /api/equipment/:id/licenses
async function getEquipmentLicenses(req, res, next) {
  try {
    const equipment = await equipmentModel.findById(req.params.id);
    if (!equipment) return res.status(404).json({ error: 'Equipment not found' });

    const licenses = await softwareLicenseModel.getEquipmentLicenses(req.params.id);
    res.json({
      equipment_id: Number(req.params.id),
      device_name: equipment.device_name || equipment.computer_name,
      count: licenses.length,
      licenses,
    });
  } catch (err) {
    next(err);
  }
}

// GET /api/licenses/:id/equipment - which devices use this licence
async function getLicenseEquipment(req, res, next) {
  try {
    const license = await softwareLicenseModel.findLicenseById(req.params.id);
    if (!license) return res.status(404).json({ error: 'Licence not found' });

    const equipment = await softwareLicenseModel.getLicenseEquipment(req.params.id);
    res.json({
      license_id: Number(req.params.id),
      product_name: license.product_name,
      license_type: license.license_type,
      install_count: equipment.length,
      equipment,
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/equipment/:id/licenses
// Body: { license_id } to add one, or { license_ids: [...] } to replace the set
async function assignLicense(req, res, next) {
  const { license_id, license_ids } = req.body;

  if (!license_id && !Array.isArray(license_ids)) {
    return res.status(400).json({
      error: 'Send license_id to add one, or license_ids to replace the whole set',
      example: { license_id: 3 },
    });
  }

  try {
    const equipment = await equipmentModel.findById(req.params.id);
    if (!equipment) return res.status(404).json({ error: 'Equipment not found' });

    // Replacing the set - for a tick-box form that saves everything at once
    if (Array.isArray(license_ids)) {
      for (const id of license_ids) {
        const found = await softwareLicenseModel.findLicenseById(id);
        if (!found) {
          return res.status(404).json({ error: `Licence ${id} not found` });
        }
      }

      const licenses = await softwareLicenseModel.setEquipmentLicenses(req.params.id, license_ids);
      return res.json({
        message: `${licenses.length} licence(s) set on this device`,
        equipment_id: Number(req.params.id),
        licenses,
      });
    }

    // Adding a single licence, leaving any others in place
    const license = await softwareLicenseModel.findLicenseById(license_id);
    if (!license) return res.status(404).json({ error: 'Licence not found' });

    const licenses = await softwareLicenseModel.assignLicenseToEquipment(
      req.params.id, license_id,
      { installedDate: req.body.installed_date, remark: req.body.remark }
    );

    res.json({
      message: `"${license.product_name}" assigned`,
      equipment_id: Number(req.params.id),
      licenses,
    });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/equipment/:id/licenses/:licenseId
// Named unassignLicense, not removeLicense - that name is for deleting the
// license definition itself, below, a different and much bigger operation.
async function unassignLicense(req, res, next) {
  try {
    const removed = await softwareLicenseModel.removeLicenseFromEquipment(
      req.params.id, req.params.licenseId
    );
    if (!removed) {
      return res.status(404).json({ error: 'That licence is not assigned to this device' });
    }

    const licenses = await softwareLicenseModel.getEquipmentLicenses(req.params.id);
    res.json({
      message: 'Licence removed from this device',
      equipment_id: Number(req.params.id),
      remaining: licenses.length,
      licenses,
    });
  } catch (err) {
    next(err);
  }
}

// --- license definitions ---

// POST /api/licenses  (admin)
async function createLicense(req, res, next) {
  const { product_name, license_type } = req.body;

  if (!product_name) {
    return res.status(400).json({ error: 'product_name is required' });
  }
  if (!license_type) {
    return res.status(400).json({
      error: 'license_type is required',
      validValues: ['Free', 'Annual Subscription', 'Perpetual'],
    });
  }
  if (!['Free', 'Annual Subscription', 'Perpetual'].includes(license_type)) {
    return res.status(400).json({
      error: 'license_type must be one of: Free, Annual Subscription, or Perpetual',
    });
  }
  if (license_type === 'Annual Subscription' && !req.body.date_expire) {
    return res.status(400).json({
      error: 'date_expire is required for Annual Subscription licenses',
      hint: 'For Free and Perpetual licenses, date_expire can be null',
    });
  }
  if (req.body.status) {
    return res.status(400).json({
      error: 'status cannot be set manually',
      hint: 'Status is automatically calculated from license_type: Free/Perpetual = active, Annual Subscription = based on dates (pending, active, near expire, expired)',
    });
  }

  try {
    const license = await softwareLicenseModel.createLicense(req.body);
    res.status(201).json({ message: 'Software license created', license });
  } catch (err) {
    next(err);
  }
}

// PUT /api/licenses/:id  (admin)
async function updateLicense(req, res, next) {
  if (req.body.status) {
    return res.status(400).json({
      error: 'status cannot be set manually',
      hint: 'Status is automatically recalculated based on license_type and dates',
    });
  }
  if (req.body.license_type && !['Free', 'Annual Subscription', 'Perpetual'].includes(req.body.license_type)) {
    return res.status(400).json({
      error: 'license_type must be one of: Free, Annual Subscription, or Perpetual',
    });
  }

  try {
    const license = await softwareLicenseModel.updateLicense(req.params.id, req.body);
    if (!license) return res.status(404).json({ error: 'Software license not found' });
    res.json({ message: 'Software license updated', license });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/licenses/:id  (admin) - the definition, not one device's use of it
async function removeLicense(req, res, next) {
  try {
    const license = await softwareLicenseModel.removeLicense(req.params.id, req.user);
    if (!license) return res.status(404).json({ error: 'Software license not found' });
    res.json({
      message: `Software license "${license.product_name}" moved to the recycle bin`,
      license,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getAllLicenses,
  getLicenses,
  getEquipmentLicenses,
  getLicenseEquipment,
  assignLicense,
  unassignLicense,
  createLicense,
  updateLicense,
  removeLicense,
};