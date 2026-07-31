const express = require('express');
const router = express.Router();
const miscController = require('../controllers/miscController');
const { authenticate } = require('../middleware/auth');

router.get('/ssd-upgrades', authenticate, miscController.getSsdUpgrades);
router.get('/ssd-procurement', authenticate, miscController.getSsdProcurement);
router.get('/licenses', authenticate, miscController.getLicenses);
router.get('/server-usage', authenticate, miscController.getServerUsage);
router.get('/antivirus', authenticate, miscController.getAntivirus);
router.get('/replacements', authenticate, miscController.getReplacements);
router.get('/cloud-rates', authenticate, miscController.getCloudRates);
router.get('/cloud-usage', authenticate, miscController.getCloudUsage);

module.exports = router;
