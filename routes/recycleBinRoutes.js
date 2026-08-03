const express = require('express');
const router = express.Router();
const recycleBinController = require('../controllers/recycleBinController');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { auditActivity } = require('../middleware/auditActivity');

// The bin holds deleted records and who deleted them - admin only throughout.
router.get('/', authenticate, requireAdmin, recycleBinController.getAll);
router.get('/:id', authenticate, requireAdmin, recycleBinController.getById);

router.post('/:id/restore', authenticate, requireAdmin,
  auditActivity('recycle_bin', 'restore'), recycleBinController.restore);

// Empty-the-bin is declared before /:id so "purge-all" is not read as an id.
router.delete('/purge-all', authenticate, requireAdmin,
  auditActivity('recycle_bin', 'purge_all'), recycleBinController.purgeAll);

router.delete('/:id', authenticate, requireAdmin,
  auditActivity('recycle_bin', 'purge'), recycleBinController.purge);

module.exports = router;