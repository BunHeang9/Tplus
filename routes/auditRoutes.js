const express = require('express');
const router = express.Router();
const auditController = require('../controllers/auditController');
const { authenticate, requireAdmin } = require('../middleware/auth');

// The activity log is visible only to administrators.
router.get('/', authenticate, requireAdmin, auditController.getAll);

module.exports = router;
