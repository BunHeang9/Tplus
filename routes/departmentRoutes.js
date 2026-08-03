const express = require('express');
const router = express.Router();
const departmentController = require('../controllers/departmentController');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { auditActivity } = require('../middleware/auditActivity');

router.get('/', authenticate, departmentController.getAll);
router.get('/:id', authenticate, departmentController.getById);
router.post('/', authenticate, requireAdmin, departmentController.create);
router.put('/:id', authenticate, auditActivity('department'), departmentController.update);
router.delete('/:id', authenticate, auditActivity('department'), departmentController.remove);

module.exports = router;
