const recycleBinModel = require('../models/recycleBinModel');

// Admin-only. Routes enforce that; this layer assumes it.

// GET /api/recycle-bin?entity_type=employee
async function getAll(req, res, next) {
  try {
    const items = await recycleBinModel.findAll(req.query.entity_type);

    // Counts per type let the UI show tabs with badges without a second call.
    const byType = items.reduce((acc, item) => {
      acc[item.entity_type] = (acc[item.entity_type] || 0) + 1;
      return acc;
    }, {});

    res.json({ count: items.length, by_type: byType, items });
  } catch (err) {
    next(err);
  }
}

// GET /api/recycle-bin/:id - includes the stored row, parsed
async function getById(req, res, next) {
  try {
    const entry = await recycleBinModel.findById(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Recycle bin entry not found' });

    let parsed = null;
    try {
      parsed = JSON.parse(entry.entity_data);
    } catch {
      // Malformed JSON should not take down the whole request - show what we
      // can and flag it, so an admin can still see the entry exists.
      parsed = { error: 'Stored data could not be parsed' };
    }

    res.json({ ...entry, entity_data: parsed });
  } catch (err) {
    next(err);
  }
}

// POST /api/recycle-bin/:id/restore
async function restore(req, res, next) {
  try {
    const result = await recycleBinModel.restore(
      req.params.id,
      req.user?.username,
    );

    // Each failure gets its own message - "restore failed" tells an admin
    // nothing about what to do next.
    switch (result.error) {
      case 'not_found':
        return res.status(404).json({ error: 'Recycle bin entry not found' });

      case 'already_restored':
        return res.status(409).json({
          error: `This was already restored on ${new Date(result.entry.restored_at).toISOString().slice(0, 10)} by ${result.entry.restored_by || 'someone'}`,
        });

      case 'unknown_type':
        return res.status(400).json({
          error: `Cannot restore entity type "${result.entry.entity_type}" - no target table is configured for it`,
        });

      case 'id_taken':
        return res.status(409).json({
          error: `Cannot restore: ${result.entry.entity_type} id ${result.entry.entity_id} already exists`,
          hint: 'Something has taken that id since the delete. Restoring would overwrite it, so this has to be sorted out manually.',
        });

      case 'no_columns':
        return res.status(422).json({
          error: 'Cannot restore: none of the stored columns still exist on the table',
        });

      default:
        return res.json({
          message: `${result.entry.entity_type} "${result.entry.entity_label}" restored`,
          entity_type: result.entry.entity_type,
          entity_id: result.entry.entity_id,
          restored: result.restored,
        });
    }
  } catch (err) {
    // A duplicate key on some other unique column - asset code, username -
    // rather than the primary key.
    if (err.number === 2627 || err.number === 2601) {
      return res.status(409).json({
        error: 'Cannot restore: a unique value on this record clashes with an existing one',
        detail: err.message,
        hint: 'Something created since the delete is using the same code, tag or username.',
      });
    }
    next(err);
  }
}

// DELETE /api/recycle-bin/:id - permanent
async function purge(req, res, next) {
  try {
    const entry = await recycleBinModel.findById(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Recycle bin entry not found' });

    await recycleBinModel.purge(req.params.id);
    res.json({
      message: `${entry.entity_type} "${entry.entity_label}" permanently deleted`,
      entity_type: entry.entity_type,
      entity_id: entry.entity_id,
    });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/recycle-bin?confirm=true - empties the bin
async function purgeAll(req, res, next) {
  // Emptying the bin is unrecoverable, so it takes a deliberate flag rather
  // than being one mistaken click away.
  if (req.query.confirm !== 'true') {
    return res.status(400).json({
      error: 'This permanently deletes everything in the bin',
      hint: 'Add ?confirm=true to proceed.',
    });
  }

  try {
    const removed = await recycleBinModel.purgeAll(req.query.entity_type);
    res.json({ message: `${removed} item(s) permanently deleted`, count: removed });
  } catch (err) {
    next(err);
  }
}

module.exports = { getAll, getById, restore, purge, purgeAll };