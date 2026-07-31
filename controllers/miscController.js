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

module.exports = {
  getSsdUpgrades:    simpleHandler(miscModel.getSsdUpgrades),
  getSsdProcurement: simpleHandler(miscModel.getSsdProcurement),
  getLicenses:       simpleHandler(miscModel.getLicenses),
  getServerUsage:    simpleHandler(miscModel.getServerUsage),
  getAntivirus:      simpleHandler(miscModel.getAntivirus),
  getReplacements:   simpleHandler(miscModel.getReplacements),
  getCloudRates:     simpleHandler(miscModel.getCloudRates),
  getCloudUsage:     simpleHandler(miscModel.getCloudUsage),
};
