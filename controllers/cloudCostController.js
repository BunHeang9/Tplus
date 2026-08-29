const cloudCostModel = require('../models/cloudCostModel');

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
  getCloudRates: simpleHandler(cloudCostModel.getCloudRates),
  getCloudUsage: simpleHandler(cloudCostModel.getCloudUsage),
};
