const express = require('express');
const router = express.Router();
const categoryController = require('../controllers/categoryController');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { auditActivity } = require('../middleware/auditActivity');

router.get('/', authenticate, categoryController.getAll);
router.get('/:id', authenticate, categoryController.getById);
router.post('/', authenticate, requireAdmin, categoryController.create);
router.put('/:id', authenticate, auditActivity('category'), categoryController.update);
router.delete('/:id', authenticate, auditActivity('category'), categoryController.remove);

module.exports = router;
