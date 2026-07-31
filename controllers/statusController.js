const statusModel = require('../models/statusModel');

async function getAll(req, res, next) {
  try {
    const statuses = await statusModel.findAll(req.query.all !== 'true');
    res.json(statuses);
  } catch (err) { next(err); }
}

async function getById(req, res, next) {
  try {
    const status = await statusModel.findById(req.params.id);
    if (!status) return res.status(404).json({ error: 'Status not found' });
    res.json(status);
  } catch (err) { next(err); }
}

module.exports = { getAll, getById };
