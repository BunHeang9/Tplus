const express = require('express');
const router = express.Router();
const employeeController = require('../controllers/employeeController');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { auditActivity } = require('../middleware/auditActivity');

// NOTE: /search must be declared before /:id, otherwise Express would
// treat the word "search" as an :id value and never reach this handler.
router.get('/search', authenticate, employeeController.search);
router.get('/', authenticate, employeeController.getAll);
router.get('/:id', authenticate, employeeController.getById);
router.get('/:id/full', authenticate, employeeController.getFull);
router.get('/:id/replacements', authenticate, employeeController.getReplacements);
router.get('/:id/part-replacements', authenticate, employeeController.getPartReplacements);

router.post('/', authenticate, requireAdmin, employeeController.create);
router.put('/:id', authenticate, auditActivity('employee'), employeeController.update);
router.delete('/:id', authenticate, auditActivity('employee'), employeeController.remove);

module.exports = router;
