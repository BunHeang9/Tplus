const express = require('express');
const router = express.Router();
const partController = require('../controllers/partController');
const { authenticate } = require('../middleware/auth');

// GET /api/part-replacements?category=Laptop&part_type_id=&from=&to=&q=
//
// The global history view - was documented in partController.js but never
// actually mounted anywhere, so it 404'd for anyone who tried it. Per-device
// history (GET /api/equipment/:id/part-replacements) lives in
// equipmentRoutes.js and was unaffected.
router.get('/', authenticate, partController.getAll);

module.exports = router;
