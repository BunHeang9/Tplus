const express = require('express');
const router = express.Router();
const customFieldController = require('../controllers/customFieldController');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { auditActivity } = require('../middleware/auditActivity');

// Fixed paths before /:fieldId, or "types" is read as an id.
router.get('/types', authenticate, customFieldController.getTypes);
router.get('/', authenticate, customFieldController.getAll);

// Anyone logged in can read a category's fields - the Add Equipment form
// needs them. Changing definitions is admin only.
router.get('/category/:categoryId', authenticate, customFieldController.getByCategory);

router.post('/category/:categoryId/attach', authenticate, requireAdmin,
  auditActivity('custom_field', 'attach'), customFieldController.attach);

router.delete('/category/:categoryId/field/:fieldId', authenticate, requireAdmin,
  auditActivity('custom_field', 'detach'), customFieldController.detach);

router.post('/', authenticate, requireAdmin,
  auditActivity('custom_field', 'create'), customFieldController.create);

router.put('/:fieldId', authenticate, requireAdmin,
  auditActivity('custom_field', 'update'), customFieldController.update);

router.delete('/:fieldId', authenticate, requireAdmin,
  auditActivity('custom_field', 'delete'), customFieldController.remove);

module.exports = router;