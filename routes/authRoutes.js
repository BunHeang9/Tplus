const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { authenticate, requireAdmin } = require('../middleware/auth');

router.post('/login', authController.login);
router.post('/signup', authController.signup);   // public - always creates a viewer
router.get('/me', authenticate, authController.me);
router.post('/change-password', authenticate, authController.changePassword);
router.post('/forgot-password', authController.forgotPassword); // public
router.post('/reset-password', authController.resetPasswordWithCode); // public - authenticated by the emailed code, not credentials
router.post('/register', authenticate, requireAdmin, authController.register);

module.exports = router;
