const express = require('express');
const router = express.Router();
const partBorrowController = require('../controllers/partBorrowController');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { auditActivity } = require('../middleware/auditActivity');

// Specific paths before /:id so they aren't swallowed as an id
router.get('/available', authenticate, partBorrowController.getAvailable);
router.get('/current', authenticate, partBorrowController.getCurrent);
router.get('/history', authenticate, partBorrowController.getHistory);
router.get('/returns', authenticate, partBorrowController.getReturns);
router.get('/borrower/:id', authenticate, partBorrowController.getByBorrower);
router.get('/:id', authenticate, partBorrowController.getById);

router.post('/', authenticate,
  auditActivity('part_borrow', 'borrow'), partBorrowController.borrow);

router.post('/:id/return', authenticate,
  auditActivity('part_borrow', 'return'), partBorrowController.returnItem);

router.delete('/:id', authenticate, requireAdmin,
  auditActivity('part_borrow', 'delete'), partBorrowController.remove);

module.exports = router;
