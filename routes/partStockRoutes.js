const express = require('express');
const router = express.Router();
const controller = require('../controllers/partStockController');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { auditActivity } = require('../middleware/auditActivity');

// Fixed paths before /:id.
router.get('/summary', authenticate, controller.getSummary);
router.get('/available', authenticate, controller.getAvailable);
router.get('/', authenticate, controller.getAll);

router.post('/', authenticate, requireAdmin,
  auditActivity('part_stock', 'add'), controller.add);
router.put('/:id', authenticate, requireAdmin,
  auditActivity('part_stock', 'update'), controller.update);
router.delete('/:id', authenticate, requireAdmin,
  auditActivity('part_stock', 'delete'), controller.remove);

module.exports = router;