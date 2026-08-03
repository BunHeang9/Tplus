const express = require('express');
const router = express.Router();
const equipmentController = require('../controllers/equipmentController');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { auditActivity } = require("../middleware/auditActivity");

// /categories before /:id for the same reason as /search above.
router.get('/categories', authenticate, equipmentController.getCategories);
router.get('/', authenticate, equipmentController.getAll);
router.get('/:id', authenticate, equipmentController.getById);

router.put(
  "/:id/owner",
  authenticate,
  auditActivity("equipment", "reassign"),
  equipmentController.updateOwner,
);
router.post(
  "/unassign",
  authenticate,
  auditActivity("equipment", "unassign"),
  equipmentController.unassign,
);
router.put(
  "/:id",
  authenticate,
  auditActivity("equipment"),
  equipmentController.update,
);

module.exports = router;
