const express = require('express');
const router = express.Router();
const cloudCostController = require('../controllers/cloudCostController');
const { authenticate } = require('../middleware/auth');

router.get('/cloud-rates', authenticate, cloudCostController.getCloudRates);
router.get('/cloud-usage', authenticate, cloudCostController.getCloudUsage);

module.exports = router;
