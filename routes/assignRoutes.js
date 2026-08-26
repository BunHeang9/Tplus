const express = require('express');
const router = express.Router();
const assignController = require('../controllers/assignController');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { auditActivity } = require('../middleware/auditActivity');

// Dropdown data for the assign page. Readable by anyone logged in - the page
// needs them to render before the admin does anything.
router.get('/form-data', authenticate, assignController.getFormData);
router.get('/available', authenticate, assignController.getAvailableEquipment);
router.get('/employees', authenticate, assignController.getEmployees);

router.post('/', authenticate, requireAdmin,
  auditActivity('equipment', 'assign'), assignController.assign);

module.exports = router;