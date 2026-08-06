const express = require('express');
const router = express.Router();
const viewColumnController = require('../controllers/viewColumnController');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { auditActivity } = require('../middleware/auditActivity');

// Configuring what a view shows is an admin job - a viewer changing which
// columns everyone sees would be a surprising amount of power.
router.get('/available-fields', authenticate, requireAdmin, viewColumnController.getAvailableFields);
router.get('/', authenticate, requireAdmin, viewColumnController.listViews);
router.get('/:categoryId', authenticate, requireAdmin, viewColumnController.getByCategory);

router.put('/:categoryId', authenticate, requireAdmin,
  auditActivity('category_view', 'configure'), viewColumnController.setColumns);

module.exports = router;