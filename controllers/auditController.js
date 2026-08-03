const auditModel = require('../models/auditModel');

async function getAll(req, res, next) {
  try {
    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isInteger(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), 1000)
      : 200;
    res.json(await auditModel.findAll(limit));
  } catch (err) {
    next(err);
  }
}

module.exports = { getAll };
