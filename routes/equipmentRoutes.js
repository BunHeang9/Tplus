const express = require('express');
const router = express.Router();
const equipmentController = require('../controllers/equipmentController');
const { authenticate, requireAdmin } = require('../middleware/auth');

// /categories before /:id for the same reason as /search above.
router.get('/categories', authenticate, equipmentController.getCategories);
router.get('/', authenticate, equipmentController.getAll);
router.get('/:id', authenticate, equipmentController.getById);

router.put('/:id/owner', authenticate, requireAdmin, equipmentController.updateOwner);
router.post('/unassign', authenticate, requireAdmin, equipmentController.unassign);
router.put('/:id', authenticate, requireAdmin, equipmentController.update);

module.exports = router;
