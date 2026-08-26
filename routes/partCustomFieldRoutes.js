const express = require('express');
const router = express.Router();
const partCustomFieldController = require('../controllers/partCustomFieldController');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { auditActivity } = require('../middleware/auditActivity');

// Fixed paths before /:fieldId, or "types" is read as an id.
router.get('/types', authenticate, partCustomFieldController.getTypes);
router.get('/', authenticate, partCustomFieldController.getAll);

// Anyone logged in can read a part type's fields - the Add Stock form needs
// them. Changing definitions is admin only.
router.get('/part-type/:partTypeId', authenticate, partCustomFieldController.getByPartType);

router.post('/part-type/:partTypeId/attach', authenticate, requireAdmin,
  auditActivity('part_custom_field', 'attach'), partCustomFieldController.attach);

router.delete('/part-type/:partTypeId/field/:fieldId', authenticate, requireAdmin,
  auditActivity('part_custom_field', 'detach'), partCustomFieldController.detach);

router.post('/', authenticate, requireAdmin,
  auditActivity('part_custom_field', 'create'), partCustomFieldController.create);

router.put('/:fieldId', authenticate, requireAdmin,
  auditActivity('part_custom_field', 'update'), partCustomFieldController.update);

router.delete('/:fieldId', authenticate, requireAdmin,
  auditActivity('part_custom_field', 'delete'), partCustomFieldController.remove);

module.exports = router;
