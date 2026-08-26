const express = require('express');
const router = express.Router();
const statusController = require('../controllers/statusController');
const { authenticate, requireAdmin } = require("../middleware/auth");
const { auditActivity } = require("../middleware/auditActivity");

router.get('/', authenticate, statusController.getAll);
router.get('/:id', authenticate, statusController.getById);

// Statuses drive what stock and borrow allow, so changing them is admin only.
router.post('/', authenticate, requireAdmin,
  auditActivity('status', 'create'), statusController.create);

router.put('/:id', authenticate, requireAdmin,
  auditActivity('status', 'update'), statusController.update);

router.delete('/:id', authenticate, requireAdmin,
  auditActivity('status', 'delete'), statusController.remove);

module.exports = router;