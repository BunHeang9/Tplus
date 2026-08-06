const express = require('express');
const router = express.Router();
const borrowController = require('../controllers/borrowController');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { auditActivity } = require("../middleware/auditActivity");
// Specific paths before /:id so they aren't swallowed as an id
router.get('/available', authenticate, borrowController.getAvailable);
router.get('/current', authenticate, borrowController.getCurrent);
router.get('/history', authenticate, borrowController.getHistory);
router.get('/returns', authenticate, borrowController.getReturns);
router.get('/borrower/:id', authenticate, borrowController.getByBorrower);
router.get('/:id', authenticate, borrowController.getById);

router.post(
  "/",
  authenticate,
  auditActivity("borrow", "borrow"),
  borrowController.borrow,
);
router.post(
  "/return",
  authenticate,
  auditActivity("borrow", "return"),
  borrowController.returnItem,
);
router.post(
  "/:id/return",
  authenticate,
  auditActivity("borrow", "return"),
  borrowController.returnItem,
);
module.exports = router;
