const express = require('express');
const router = express.Router();
const miscController = require('../controllers/miscController');
const { authenticate, requireAdmin } = require("../middleware/auth");
const { auditActivity } = require("../middleware/auditActivity");
router.get('/ssd-upgrades', authenticate, miscController.getSsdUpgrades);
router.get('/ssd-procurement', authenticate, miscController.getSsdProcurement);
router.get('/licenses', authenticate, miscController.getLicenses);
router.get('/server-usage', authenticate, miscController.getServerUsage);
router.get('/antivirus', authenticate, miscController.getAntivirus);
router.get('/replacements', authenticate, miscController.getReplacements);
router.get('/cloud-rates', authenticate, miscController.getCloudRates);
router.get('/cloud-usage', authenticate, miscController.getCloudUsage);

router.post(
  "/licenses",
  authenticate,
  requireAdmin,
  auditActivity("license", "create"),
  miscController.createLicense,
);
router.put(
  "/licenses/:id",
  authenticate,
  requireAdmin,
  auditActivity("license", "update"),
  miscController.updateLicense,
);

router.delete(
  "/licenses/:id",
  authenticate,
  requireAdmin,
  auditActivity("license", "delete"),
  miscController.removeLicense,
);
module.exports = router;
