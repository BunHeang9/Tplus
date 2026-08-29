const deviceReplacementModel = require('../models/deviceReplacementModel');

async function getReplacements(req, res, next) {
  try {
    res.json(await deviceReplacementModel.getReplacements());
  } catch (err) {
    next(err);
  }
}

module.exports = { getReplacements };
