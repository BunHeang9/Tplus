const express = require('express');
const router = express.Router();
const statusController = require('../controllers/statusController');
const { authenticate } = require('../middleware/auth');

router.get('/', authenticate, statusController.getAll);
router.get('/:id', authenticate, statusController.getById);

module.exports = router;
