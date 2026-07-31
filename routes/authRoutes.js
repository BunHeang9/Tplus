const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { authenticate, requireAdmin } = require('../middleware/auth');

router.post('/login', authController.login);
router.post('/signup', authController.signup);   // public - always creates a viewer
router.get('/me', authenticate, authController.me);
router.post('/register', authenticate, requireAdmin, authController.register);

module.exports = router;
