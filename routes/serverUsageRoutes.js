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

// Self-service usage form - any signed-in user, not just admins. Keyed by
// equipment_id (what a user actually has on hand), not usage_id - creates
// the server_usage row if this equipment has never had one. Deliberately
// narrower than POST / above: only cpu_usage_pct/memory_usage_pct/
// hdd_usage_gb, never capacity/due date/owner/remark - see
// serverUsageController.updateUsage()'s comment.
router.patch(
  '/equipment/:id/usage',
  authenticate,
  auditActivity('server_usage', 'update_usage'),
  serverUsageController.updateUsage,
);

router.delete(
  '/:id',
  authenticate,
  requireAdmin,
  auditActivity('server_usage', 'delete'),
  serverUsageController.removeServerUsage,
);

module.exports = router;
