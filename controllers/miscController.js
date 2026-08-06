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
  const { product_name, date_expire } = req.body;

  if (!product_name) {
    return res.status(400).json({ error: "product_name is required" });
  }
  if (!date_expire) {
    return res.status(400).json({
      error: "date_expire is required - status is calculated from it",
    });
  }
  if (req.body.status) {
    return res.status(400).json({
      error: "status cannot be set manually",
      hint: "It is calculated from date_expire: expired, near expire (within a month), or active.",
    });
  }

  try {
    const license = await miscModel.createLicense(req.body);
    res.status(201).json({ message: "Licence created", license });
  } catch (err) {
    next(err);
  }
}
async function updateLicense(req, res, next) {
  if (req.body.status) {
    return res.status(400).json({
      error: "status cannot be set manually",
      hint: "It is recalculated from date_expire whenever the licence changes.",
    });
  }

  try {
    const license = await miscModel.updateLicense(req.params.id, req.body);
    if (!license) {
      return res.status(404).json({ error: "Licence not found" });
    }
    res.json({ message: "Licence updated", license });
  } catch (err) {
    next(err);
  }
}

async function removeLicense(req, res, next) {
  try {
    const license = await miscModel.removeLicense(req.params.id, req.user);
    if (!license) {
      return res.status(404).json({ error: "Licence not found" });
    }
    res.json({
      message: `Licence "${license.product_name}" moved to the recycle bin`,
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
