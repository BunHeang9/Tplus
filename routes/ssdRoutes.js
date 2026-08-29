const express = require('express');
const router = express.Router();
const ssdController = require('../controllers/ssdController');
const { authenticate } = require('../middleware/auth');

router.get('/ssd-upgrades', authenticate, ssdController.getSsdUpgrades);
router.get('/ssd-procurement', authenticate, ssdController.getSsdProcurement);

module.exports = router;
