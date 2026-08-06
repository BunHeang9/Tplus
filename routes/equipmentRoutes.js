const express = require('express');
const router = express.Router();
const equipmentController = require('../controllers/equipmentController');
const categoryViewController = require("../controllers/categoryViewController");
const { authenticate, requireAdmin } = require('../middleware/auth');
const { auditActivity } = require("../middleware/auditActivity");

// Express matches routes in order, so fixed paths come before '/:id'.
//
// View keys used to be hardcoded in a regex here. Now that an admin can create
// a category from the dashboard, that list is not known at startup - so :id
// routes check for a number instead, and anything non-numeric falls through to
// the view handler. A new category works the moment it is created, with no
// restart.
const numeric = '\\d+';

router.get('/categories', authenticate, equipmentController.getCategories);
router.get("/views", authenticate, categoryViewController.getViews);

router.post(
  "/unassign",
  authenticate,
  auditActivity("equipment", "unassign"),
  equipmentController.unassign,
);

router.get("/", authenticate, equipmentController.getAll);

// Numeric id routes, declared before the view routes so a real id is never
// mistaken for a view key.
router.get(`/:id(${numeric})`, authenticate, equipmentController.getById);
router.put(
  `/:id(${numeric})/owner`,
  authenticate,
  auditActivity("equipment", "reassign"),
  equipmentController.updateOwner,
);
router.put(
  `/:id(${numeric})`,
  authenticate,
  auditActivity("equipment"),
  equipmentController.update,
);
// Admin only - deleting equipment is for mistaken entries. A real device that
// is no longer in service should be retired instead, which keeps its history.
router.delete(
  `/:id(${numeric})`,
  authenticate,
  requireAdmin,
  auditActivity("equipment"),
  equipmentController.remove,
);

// Per-category views: /api/equipment/cctv, /laptop, /printer and any category
// added later. The handler returns 404 with the valid list if the key is
// unknown, so a typo gives a useful message rather than a confusing one.
router.get("/:view", authenticate, categoryViewController.getByView);
router.post(
  "/:view",
  authenticate,
  requireAdmin,
  auditActivity("equipment", "create"),
  categoryViewController.createInView,
);
router.put(
  "/:view/:id",
  authenticate,
  auditActivity("equipment"),
  categoryViewController.updateInView,
);

module.exports = router;