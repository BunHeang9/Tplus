const express = require('express');
const router = express.Router();
const deviceReplacementController = require('../controllers/deviceReplacementController');
const { authenticate } = require('../middleware/auth');

router.get('/', authenticate, deviceReplacementController.getReplacements);

module.exports = router;
