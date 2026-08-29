const express = require('express');
const router = express.Router();
const serverUsageController = require('../controllers/serverUsageController');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { auditActivity } = require('../middleware/auditActivity');

router.get('/', authenticate, serverUsageController.getServerUsage);

router.post(
  '/',
  authenticate,
  requireAdmin,
  auditActivity('server_usage', 'set'),
  serverUsageController.setServerUsage,
);
router.delete(
  '/:id',
  authenticate,
  requireAdmin,
  auditActivity('server_usage', 'delete'),
  serverUsageController.removeServerUsage,
);

module.exports = router;
