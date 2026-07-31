const filterModel = require('../models/filterModel');

async function getFilterOptions(req, res, next) {
  try {
    const options = await filterModel.getAllFilterOptions();
    res.json(options);
  } catch (err) {
    next(err);
  }
}

module.exports = { getFilterOptions };
