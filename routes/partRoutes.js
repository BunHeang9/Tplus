const express = require('express');
const router = express.Router();
const partController = require('../controllers/partController');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { auditActivity } = require('../middleware/auditActivity');

// Fixed paths before /:id, or "columns"/"stock-columns" is read as an id.
router.get('/columns', authenticate, requireAdmin, partController.getAvailableColumns);
router.get('/stock-columns', authenticate, requireAdmin, partController.getAvailableStockFields);
router.get('/', authenticate, partController.getTypes);

// Which categories a part applies to.
router.get('/:id/categories', authenticate, requireAdmin, partController.getTypeCategories);
router.put('/:id/categories', authenticate, requireAdmin,
  auditActivity('part_type', 'set_categories'), partController.setTypeCategories);

// Which part_stock columns this part type's Add/Edit Stock form shows.
router.get('/:id/stock-columns', authenticate, partController.getPartTypeStockColumns);
router.put('/:id/stock-columns', authenticate, requireAdmin,
  auditActivity('part_type', 'set_stock_columns'), partController.setPartTypeStockColumns);

router.post('/', authenticate, requireAdmin,
  auditActivity('part_type', 'create'), partController.createType);
router.put('/:id', authenticate, requireAdmin,
  auditActivity('part_type', 'update'), partController.updateType);
router.delete('/:id', authenticate, requireAdmin,
  auditActivity('part_type', 'delete'), partController.removeType);

module.exports = router;