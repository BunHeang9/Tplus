const express = require('express');
const router = express.Router();
const antivirusInstallController = require('../controllers/antivirusInstallController');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { auditActivity } = require('../middleware/auditActivity');

router.get('/', authenticate, antivirusInstallController.getAntivirus);

router.post(
  '/',
  authenticate,
  requireAdmin,
  auditActivity('antivirus_install', 'create'),
  antivirusInstallController.createAntivirusInstall,
);
router.put(
  '/:id',
  authenticate,
  requireAdmin,
  auditActivity('antivirus_install', 'update'),
  antivirusInstallController.updateAntivirusInstall,
);
router.delete(
  '/:id',
  authenticate,
  requireAdmin,
  auditActivity('antivirus_install', 'delete'),
  antivirusInstallController.removeAntivirusInstall,
);

module.exports = router;
