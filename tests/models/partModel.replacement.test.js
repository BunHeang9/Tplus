// DB-backed - see tests/README.md. All part types, stock lines, and
// equipment created here are scratch-only, cleaned up in afterAll.
//
// Covers the highest-complexity conversion in the sequelize-migration
// branch's audit: partModel.create()/removeReplacement()'s full lifecycle -
// fitting a part from stock (reading the device's current value inside the
// same flow, never trusting the caller's claim of what was there before),
// summing a countable part ('add'), and undoing a replacement (restoring
// both the device field and the stock line it came from).
const sequelize = require('../../config/sequelize');
const { QueryTypes } = require('sequelize');
const partModel = require('../../models/partModel');
const partStockModel = require('../../models/partStockModel');
const equipmentModel = require('../../models/equipmentModel');

let category;
const scratchPartTypeIds = [];
const scratchEquipmentIds = [];

beforeAll(async () => {
  [category] = await sequelize.query('SELECT TOP 1 category_id FROM dbo.category WHERE is_active = 1', { type: QueryTypes.SELECT });
});

afterAll(async () => {
  for (const id of scratchEquipmentIds) {
    await sequelize.query('DELETE FROM dbo.part_replacement WHERE equipment_id = :id', { replacements: { id } });
    await sequelize.query('DELETE FROM dbo.equipment_custom_value WHERE equipment_id = :id', { replacements: { id } });
    await sequelize.query('DELETE FROM dbo.equipment WHERE equipment_id = :id', { replacements: { id } });
  }
  for (const id of scratchPartTypeIds) {
    await sequelize.query('DELETE FROM dbo.part_stock WHERE part_type_id = :id', { replacements: { id } });
    await sequelize.query('DELETE FROM dbo.part_type_category WHERE part_type_id = :id', { replacements: { id } });
    await sequelize.query('DELETE FROM dbo.part_type WHERE part_type_id = :id', { replacements: { id } });
  }
});

test('replace -> add -> undo lifecycle on a RAM-like (real equipment_column) part type', async () => {
  const ramType = await partModel.createType({
    part_name: 'TEST-JEST-RAM-' + Date.now(), equipment_column: 'ram', tracks_value: true, is_countable: true,
  });
  scratchPartTypeIds.push(ramType.part_type_id);

  const equip = await equipmentModel.createStock({
    category_id: category.category_id, device_type: 'Test', asset_code: 'TSTPM-JEST-' + Date.now().toString().slice(-6),
  });
  scratchEquipmentIds.push(equip.equipment_id);

  const stockA = await partStockModel.increment(ramType.part_type_id, '8', 'Working - IT Stock', 5);
  const stockB = await partStockModel.increment(ramType.part_type_id, '9', 'Working - IT Stock', 5); // distinct value - see note below

  // --- replace: fits stockA, device starts with no value ---
  const replaceResult = await partModel.create(equip.equipment_id, {
    part_type_id: ramType.part_type_id, action: 'replace', from_stock_id: stockA.stock_id, new_value: '8',
  }, { username: 'jest' });

  expect(replaceResult.error).toBeUndefined();
  expect(replaceResult.old_value).toBeNull(); // nothing was there before

  const equipAfterReplace = await equipmentModel.findById(equip.equipment_id);
  expect(equipAfterReplace.ram).toBe('8');

  const stockAAfterReplace = await partStockModel.findById(stockA.stock_id);
  expect(stockAAfterReplace.quantity).toBe(4); // one unit taken

  // --- add: fits stockB, sums onto the existing value ---
  const addResult = await partModel.create(equip.equipment_id, {
    part_type_id: ramType.part_type_id, action: 'add', from_stock_id: stockB.stock_id, new_value: '8',
  }, { username: 'jest' });

  expect(addResult.error).toBeUndefined();
  expect(addResult.resulting_value).toBe('16'); // 8 + 8

  const equipAfterAdd = await equipmentModel.findById(equip.equipment_id);
  expect(equipAfterAdd.ram).toBe('16');

  // 'add' actions cannot be undone (no single "before" value once several
  // have stacked) - refused, not thrown.
  const cannotUndoAdd = await partModel.removeReplacement(addResult.replacement.replacement_id, equip.equipment_id);
  expect(cannotUndoAdd.error).toBe('cannot_undo_add');

  // --- undo the 'replace' instead: device field and stock line both revert ---
  const undoResult = await partModel.removeReplacement(replaceResult.replacement.replacement_id, equip.equipment_id);
  expect(undoResult.error).toBeUndefined();

  const equipAfterUndo = await equipmentModel.findById(equip.equipment_id);
  expect(equipAfterUndo.ram).toBeNull(); // back to its old_value

  const stockAAfterUndo = await partStockModel.findById(stockA.stock_id);
  expect(stockAAfterUndo.quantity).toBe(5); // the fitted unit went back to stock

  const [historyRowGone] = await sequelize.query(
    'SELECT 1 FROM dbo.part_replacement WHERE replacement_id = :id',
    { replacements: { id: replaceResult.replacement.replacement_id }, type: QueryTypes.SELECT },
  );
  expect(historyRowGone).toBeUndefined();
});

test('replace on a custom-field-mapped (non-real-column) part type writes through customFieldModel', async () => {
  const customFieldModel = require('../../models/customFieldModel');

  const field = await customFieldModel.create({ fieldLabel: 'TEST-JEST-PM-FIELD-' + Date.now(), fieldType: 'text' });
  await customFieldModel.attachToCategory(category.category_id, field.field_id, {});

  try {
    const bagType = await partModel.createType({
      part_name: 'TEST-JEST-BAG-' + Date.now(), equipment_column: field.field_key, tracks_value: false, is_countable: false,
    });
    scratchPartTypeIds.push(bagType.part_type_id);

    const equip = await equipmentModel.createStock({
      category_id: category.category_id, device_type: 'Test', asset_code: 'TSTPM-JEST-BAG-' + Date.now().toString().slice(-6),
    });
    scratchEquipmentIds.push(equip.equipment_id);

    const bagStock = await partStockModel.increment(bagType.part_type_id, null, 'Working - IT Stock', 3, undefined, { model_name: 'BagBrand X' });

    const result = await partModel.create(equip.equipment_id, {
      part_type_id: bagType.part_type_id, action: 'replace', from_stock_id: bagStock.stock_id, new_value: 'BagBrand X',
    }, { username: 'jest' });
    expect(result.error).toBeUndefined();

    const values = await customFieldModel.getValues(equip.equipment_id);
    const bagValue = values.find((v) => v.field_key === field.field_key);
    expect(bagValue.field_value).toBe('BagBrand X');
  } finally {
    await customFieldModel.detachFromCategory(category.category_id, field.field_id);
    await sequelize.query('DELETE FROM dbo.equipment_custom_field WHERE field_id = :id', { replacements: { id: field.field_id } });
  }
});
