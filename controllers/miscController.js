const miscModel = require('../models/miscModel');

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

module.exports = {
  getSsdUpgrades: simpleHandler(miscModel.getSsdUpgrades),
  getSsdProcurement: simpleHandler(miscModel.getSsdProcurement),
  getLicenses: simpleHandler(miscModel.getLicenses),
  getServerUsage: simpleHandler(miscModel.getServerUsage),
  getAntivirus: simpleHandler(miscModel.getAntivirus),
  getReplacements: simpleHandler(miscModel.getReplacements),
  getCloudRates: simpleHandler(miscModel.getCloudRates),
  getCloudUsage: simpleHandler(miscModel.getCloudUsage),
  createLicense: createLicense,
  updateLicense: updateLicense,
  removeLicense: removeLicense,
};
