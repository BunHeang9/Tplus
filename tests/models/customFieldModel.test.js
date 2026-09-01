// DB-backed - see tests/README.md. Only ever creates/deletes its own
// scratch equipment and custom field.
const sequelize = require('../../config/sequelize');
const { QueryTypes } = require('sequelize');
const customFieldModel = require('../../models/customFieldModel');
const equipmentModel = require('../../models/equipmentModel');

let category;
let field;
let equip;

beforeAll(async () => {
  [category] = await sequelize.query('SELECT TOP 1 category_id FROM dbo.category WHERE is_active = 1', { type: QueryTypes.SELECT });
  field = await customFieldModel.create({ fieldLabel: 'TEST-JEST-CF-' + Date.now(), fieldType: 'text' });
  await customFieldModel.attachToCategory(category.category_id, field.field_id, { sortOrder: 1, isRequired: false });
  equip = await equipmentModel.createStock({
    category_id: category.category_id, device_type: 'Test', asset_code: 'TSTCF-JEST-' + Date.now().toString().slice(-6),
  });
});

afterAll(async () => {
  await sequelize.query('DELETE FROM dbo.equipment_custom_value WHERE equipment_id = :id', { replacements: { id: equip.equipment_id } });
  await sequelize.query('DELETE FROM dbo.equipment WHERE equipment_id = :id', { replacements: { id: equip.equipment_id } });
  await customFieldModel.detachFromCategory(category.category_id, field.field_id);
  await sequelize.query('DELETE FROM dbo.equipment_custom_field WHERE field_id = :id', { replacements: { id: field.field_id } });
});

test('a field attached to the category shows up with a null value before anything is set', async () => {
  const values = await customFieldModel.getValues(equip.equipment_id);
  const entry = values.find((v) => v.field_key === field.field_key);
  expect(entry).toBeDefined();
  expect(entry.field_value).toBeNull();
});

test('setValues creates a new value row', async () => {
  await customFieldModel.setValues(equip.equipment_id, { [field.field_key]: 'hello world' });
  const values = await customFieldModel.getValues(equip.equipment_id);
  const entry = values.find((v) => v.field_key === field.field_key);
  expect(entry.field_value).toBe('hello world');
});

test('setValues updates an existing value row and advances updated_at', async () => {
  const [before] = await sequelize.query(
    'SELECT updated_at FROM dbo.equipment_custom_value WHERE equipment_id = :id AND field_id = :fid',
    { replacements: { id: equip.equipment_id, fid: field.field_id }, type: QueryTypes.SELECT },
  );
  await new Promise((r) => setTimeout(r, 20));
  await customFieldModel.setValues(equip.equipment_id, { [field.field_key]: 'updated value' });
  const [after] = await sequelize.query(
    'SELECT field_value, updated_at FROM dbo.equipment_custom_value WHERE equipment_id = :id AND field_id = :fid',
    { replacements: { id: equip.equipment_id, fid: field.field_id }, type: QueryTypes.SELECT },
  );
  expect(after.field_value).toBe('updated value');
  expect(new Date(after.updated_at).getTime()).toBeGreaterThan(new Date(before.updated_at).getTime());
});

test('setValues silently skips a field_key that does not exist', async () => {
  await expect(
    customFieldModel.setValues(equip.equipment_id, { this_field_key_does_not_exist_at_all: 'x' }),
  ).resolves.not.toThrow();
});

test('setValues silently skips a real field not attached to this category', async () => {
  const unattached = await customFieldModel.create({ fieldLabel: 'TEST-JEST-UNATTACHED-' + Date.now(), fieldType: 'text' });
  try {
    await customFieldModel.setValues(equip.equipment_id, { [unattached.field_key]: 'should not be saved' });
    const [row] = await sequelize.query(
      'SELECT 1 FROM dbo.equipment_custom_value WHERE equipment_id = :id AND field_id = :fid',
      { replacements: { id: equip.equipment_id, fid: unattached.field_id }, type: QueryTypes.SELECT },
    );
    expect(row).toBeUndefined();
  } finally {
    await sequelize.query('DELETE FROM dbo.equipment_custom_field WHERE field_id = :id', { replacements: { id: unattached.field_id } });
  }
});

test('getValues on a nonexistent equipment returns an empty array', async () => {
  const values = await customFieldModel.getValues(999999999);
  expect(values).toEqual([]);
});

test('getValuesForMany groups values by equipment_id', async () => {
  const grouped = await customFieldModel.getValuesForMany([equip.equipment_id]);
  expect(grouped[equip.equipment_id][field.field_key]).toBe('updated value');
});
