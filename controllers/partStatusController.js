const partStatusModel = require('../models/partStatusModel');

// GET /api/part-statuses?include_inactive=true
async function getAll(req, res, next) {
  try {
    const statuses = await partStatusModel.findAll(req.query.include_inactive === 'true');
    res.json(statuses);
  } catch (err) {
    next(err);
  }
}

async function getById(req, res, next) {
  try {
    const status = await partStatusModel.findById(req.params.id);
    if (!status) return res.status(404).json({ error: 'Status not found' });
    res.json(status);
  } catch (err) {
    next(err);
  }
}

// POST /api/part-statuses  (admin)
async function create(req, res, next) {
  const { status_name } = req.body;

  if (!status_name) {
    return res.status(400).json({
      error: 'status_name is required',
      example: { status_name: 'Under Repair', description: 'Being fixed', is_borrowable: false },
      note: 'is_borrowable controls whether this status can be lent out through /api/part-borrow.',
    });
  }

  try {
    const existing = await partStatusModel.findByName(status_name);
    if (existing) {
      return res.status(409).json({
        error: `A status called "${status_name}" already exists`,
        existing,
      });
    }

    const status = await partStatusModel.create(req.body);
    res.status(201).json({ message: `Status "${status_name}" created`, status });
  } catch (err) {
    next(err);
  }
}

// PUT /api/part-statuses/:id  (admin)
// Renaming this cascades to every dbo.part_stock row using it automatically
// (a real foreign key with ON UPDATE CASCADE) - no separate propagation step
// needed here, unlike equipment's own status rename.
async function update(req, res, next) {
  try {
    const existing = await partStatusModel.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Status not found' });

    if (req.body.status_name && req.body.status_name !== existing.status_name) {
      const clash = await partStatusModel.findByName(req.body.status_name);
      if (clash) {
        return res.status(409).json({ error: `A status called "${req.body.status_name}" already exists` });
      }
    }

    const status = await partStatusModel.update(req.params.id, req.body);
    res.json({ message: 'Status updated', stock_affected: existing.stock_count, status });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/part-statuses/:id  (admin)
async function remove(req, res, next) {
  try {
    const existing = await partStatusModel.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Status not found' });

    // A status still in use cannot go - the part_stock rows referencing it
    // would be left pointing at nothing, and the foreign key would reject
    // it anyway.
    const count = await partStatusModel.countUsage(req.params.id);
    if (count > 0) {
      return res.status(409).json({
        error: `Cannot delete "${existing.status_name}": ${count} stock line(s) currently use it`,
        stock_count: count,
        hint: 'Move those stock lines to another status first, or set is_active to false to hide it from dropdowns while keeping existing records valid.',
      });
    }

    await partStatusModel.remove(req.params.id);
    res.json({ message: `Status "${existing.status_name}" deleted` });
  } catch (err) {
    next(err);
  }
}

module.exports = { getAll, getById, create, update, remove };
