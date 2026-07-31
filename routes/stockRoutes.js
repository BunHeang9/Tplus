const express = require('express');
const router = express.Router();
const stockController = require('../controllers/stockController');
const { authenticate, requireAdmin } = require('../middleware/auth');

router.post('/add', authenticate, requireAdmin, stockController.addStock);
router.post('/assign', authenticate, requireAdmin, stockController.assignStock);
router.get('/available', authenticate, stockController.getAvailable);
router.get('/by-date', authenticate, stockController.getByDate);

module.exports = router;
