const express = require('express');
const router = express.Router();
const softwareLicenseController = require('../controllers/softwareLicenseController');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { auditActivity } = require('../middleware/auditActivity');

// License definitions - creating/editing/deleting the product itself.
// Assigning an existing license to a device lives under
// /api/equipment/:id/licenses instead (equipmentRoutes.js), since that's
// fundamentally an equipment sub-resource, not a license one.

router.get('/', authenticate, softwareLicenseController.getLicenses);

router.post(
  '/',
  authenticate,
  requireAdmin,
  auditActivity('license', 'create'),
  softwareLicenseController.createLicense,
);
router.put(
  '/:id',
  authenticate,
  requireAdmin,
  auditActivity('license', 'update'),
  softwareLicenseController.updateLicense,
);
router.delete(
  '/:id',
  authenticate,
  requireAdmin,
  auditActivity('license', 'delete'),
  softwareLicenseController.removeLicense,
);

module.exports = router;
