const statusModel = require('../models/statusModel');

// GET /api/statuses?include_inactive=true
async function getAll(req, res, next) {
  try {
    const statuses = await statusModel.findAll(
      req.query.include_inactive === "true",
    );
    res.json(statuses);
  } catch (err) {
    next(err);
  }
}

async function getById(req, res, next) {
  try {
    const status = await statusModel.findById(req.params.id);
    if (!status) return res.status(404).json({ error: "Status not found" });
    res.json(status);
  } catch (err) {
    next(err);
  }
}

// POST /api/statuses  (admin)
async function create(req, res, next) {
  const { status_name } = req.body;

  if (!status_name) {
    return res.status(400).json({
      error: "status_name is required",
      example: {
        status_name: "Under Repair",
        description: "Away being fixed",
        is_assignable: false,
        is_borrowable: false,
      },
      note: "is_assignable and is_borrowable control whether stock and borrow can use this status.",
    });
  }

  try {
    const existing = await statusModel.findByName(status_name);
    if (existing) {
      return res.status(409).json({
        error: `A status called "${status_name}" already exists`,
        existing,
      });
    }

    const status = await statusModel.create(req.body);
    res
      .status(201)
      .json({ message: `Status "${status_name}" created`, status });
  } catch (err) {
    next(err);
  }
}

// PUT /api/statuses/:id  (admin)
async function update(req, res, next) {
  try {
    const existing = await statusModel.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: "Status not found" });

    if (req.body.status_name && req.body.status_name !== existing.status_name) {
      const clash = await statusModel.findByName(req.body.status_name);
      if (clash) {
        return res.status(409).json({
          error: `A status called "${req.body.status_name}" already exists`,
        });
      }
    }

    const status = await statusModel.update(req.params.id, req.body);

    // Renaming touches every device on that status, so say how many moved -
    // an admin renaming "Working/Using" is changing 368 records.
    res.json({
      message: `Status updated`,
      equipment_affected: existing.equipment_count,
      status,
    });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/statuses/:id  (admin)
async function remove(req, res, next) {
  try {
    const existing = await statusModel.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: "Status not found" });

    // A status in use cannot go - the equipment referencing it would be left
    // pointing at nothing, and the database would reject it anyway.
    const count = await statusModel.countUsage(req.params.id);
    if (count > 0) {
      return res.status(409).json({
        error: `Cannot delete "${existing.status_name}": ${count} device(s) currently use it`,
        equipment_count: count,
        hint: "Move those devices to another status first, or set is_active to false to hide it from dropdowns while keeping existing records valid.",
      });
    }

    await statusModel.remove(req.params.id);
    res.json({ message: `Status "${existing.status_name}" deleted` });
  } catch (err) {
    next(err);
  }
}

module.exports = { getAll, getById, create, update, remove };