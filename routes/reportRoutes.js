const express = require('express');
const router = express.Router();
const reportController = require('../controllers/reportController');
const { authenticate } = require('../middleware/auth');

// GET /api/reports/equipment?format=xlsx|pdf  (plus any GET /api/equipment filter)
router.get('/equipment', authenticate, reportController.equipmentReport);
// GET /api/reports/employees?format=xlsx|pdf&include_inactive=true
// One row per owned device; employees with none get a single "(No equipment)" row.
router.get('/employees', authenticate, reportController.employeeReport);
// GET /api/reports/borrow-history?format=xlsx|pdf  (plus any GET /api/borrow/history filter)
router.get('/borrow-history', authenticate, reportController.borrowReport);
// GET /api/reports/part-stock?format=xlsx|pdf  (plus any GET /api/part-stock filter)
router.get('/part-stock', authenticate, reportController.partStockReport);

module.exports = router;
