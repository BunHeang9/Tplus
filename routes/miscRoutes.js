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
  "/server-usage",
  authenticate,
  requireAdmin,
  auditActivity("server_usage", "set"),
  miscController.setServerUsage,
);
router.delete(
  "/server-usage/:id",
  authenticate,
  requireAdmin,
  auditActivity("server_usage", "delete"),
  miscController.removeServerUsage,
);

router.post(
  "/antivirus",
  authenticate,
  requireAdmin,
  auditActivity("antivirus_install", "create"),
  miscController.createAntivirusInstall,
);
router.put(
  "/antivirus/:id",
  authenticate,
  requireAdmin,
  auditActivity("antivirus_install", "update"),
  miscController.updateAntivirusInstall,
);
router.delete(
  "/antivirus/:id",
  authenticate,
  requireAdmin,
  auditActivity("antivirus_install", "delete"),
  miscController.removeAntivirusInstall,
);

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
