const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const { authenticate, requireAdmin } = require('../middleware/auth');

// Every route here is admin-only - viewers cannot see or manage accounts.
router.get('/', authenticate, requireAdmin, userController.getAll);
router.get('/:id', authenticate, requireAdmin, userController.getById);
router.put('/:id', authenticate, requireAdmin, userController.update);
router.post('/:id/reset-password', authenticate, requireAdmin, userController.resetPassword);

module.exports = router;
