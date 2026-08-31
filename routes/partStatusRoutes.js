const express = require('express');
const router = express.Router();
const partStatusController = require('../controllers/partStatusController');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { auditActivity } = require('../middleware/auditActivity');

router.get('/', authenticate, partStatusController.getAll);
router.get('/:id', authenticate, partStatusController.getById);

// Statuses drive what part-borrow allows, so changing them is admin only -
// same reasoning as routes/statusRoutes.js (equipment's own version).
router.post('/', authenticate, requireAdmin,
  auditActivity('part_status', 'create'), partStatusController.create);

router.put('/:id', authenticate, requireAdmin,
  auditActivity('part_status', 'update'), partStatusController.update);

router.delete('/:id', authenticate, requireAdmin,
  auditActivity('part_status', 'delete'), partStatusController.remove);

module.exports = router;
