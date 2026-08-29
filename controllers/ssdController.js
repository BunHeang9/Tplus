const ssdModel = require('../models/ssdModel');

function simpleHandler(modelFn) {
  return async (req, res, next) => {
    try {
      res.json(await modelFn());
    } catch (err) {
      next(err);
    }
  };
}

module.exports = {
  getSsdUpgrades: simpleHandler(ssdModel.getSsdUpgrades),
  getSsdProcurement: simpleHandler(ssdModel.getSsdProcurement),
};
