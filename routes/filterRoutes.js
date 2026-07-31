const express = require('express');
const router = express.Router();
const filterController = require('../controllers/filterController');
const { authenticate } = require('../middleware/auth');

router.get('/', authenticate, filterController.getFilterOptions);

module.exports = router;
