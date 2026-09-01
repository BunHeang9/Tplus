// DB-backed - see tests/README.md. Scratch employee only, always purged
// from the recycle bin in afterAll even on a failed assertion.
//
// Covers the delete -> restore round trip end to end: employeeModel.remove()
// captures a snapshot via recycleBinModel.create(), restore() puts the row
// back at its ORIGINAL id (via the IDENTITY_INSERT path, which stays raw
// SQL - no ORM equivalent exists for forcing a value into an auto-increment
// PK - this test is exactly what proves that one raw call still works
// correctly end to end), and idIsTaken() correctly reports availability.
const sequelize = require('../../config/sequelize');
const { QueryTypes } = require('sequelize');
const recycleBinModel = require('../../models/recycleBinModel');
const employeeModel = require('../../models/employeeModel');

let binIdToCleanUp = null;

afterEach(async () => {
  if (binIdToCleanUp) {
    await sequelize.query('DELETE FROM dbo.recycle_bin WHERE bin_id = :id', { replacements: { id: binIdToCleanUp } });
    binIdToCleanUp = null;
  }
});

test('idIsTaken reflects whether a real id is currently occupied', async () => {
  const [row] = await sequelize.query('SELECT TOP 1 employee_id FROM dbo.employee', { type: QueryTypes.SELECT });
  expect(await recycleBinModel.idIsTaken('employee', row.employee_id)).toBe(true);
  expect(await recycleBinModel.idIsTaken('employee', 999999999)).toBe(false);
});

test('idIsTaken returns false for an unrecognized entity_type', async () => {
  expect(await recycleBinModel.idIsTaken('not_a_real_type', 1)).toBe(false);
});

test('a deleted employee can be restored to its original id with its data intact', async () => {
  const emp = await employeeModel.create({ full_name: 'TEST-JEST-RECYCLE-' + Date.now(), position: 'Tester' });
  const originalId = emp.employee_id;

  await employeeModel.remove(originalId, emp.full_name, { user_id: 1, username: 'jest', role: 'admin' });

  const [binRow] = await sequelize.query(
    "SELECT bin_id FROM dbo.recycle_bin WHERE entity_type = 'employee' AND entity_id = :id ORDER BY bin_id DESC",
    { replacements: { id: originalId }, type: QueryTypes.SELECT },
  );
  expect(binRow).toBeDefined();
  binIdToCleanUp = binRow.bin_id;

  expect(await recycleBinModel.idIsTaken('employee', originalId)).toBe(false);

  const result = await recycleBinModel.restore(binRow.bin_id, 'jest-restorer');
  expect(result.error).toBeUndefined();

  const restored = await employeeModel.findById(originalId);
  expect(restored).not.toBeNull();
  expect(restored.employee_id).toBe(originalId); // same id, not a new one
  expect(restored.full_name).toBe(emp.full_name);
  expect(restored.position).toBe('Tester');

  // Clean up the restored employee itself (separate from the recycle_bin
  // row, which afterEach handles).
  await sequelize.query('DELETE FROM dbo.employee WHERE employee_id = :id', { replacements: { id: originalId } });
});

test('restoring the same bin row twice is refused the second time', async () => {
  const emp = await employeeModel.create({ full_name: 'TEST-JEST-RECYCLE-DOUBLE-' + Date.now() });
  await employeeModel.remove(emp.employee_id, emp.full_name, { user_id: 1, username: 'jest' });
  const [binRow] = await sequelize.query(
    "SELECT bin_id FROM dbo.recycle_bin WHERE entity_type = 'employee' AND entity_id = :id ORDER BY bin_id DESC",
    { replacements: { id: emp.employee_id }, type: QueryTypes.SELECT },
  );
  binIdToCleanUp = binRow.bin_id;

  const first = await recycleBinModel.restore(binRow.bin_id, 'jest');
  expect(first.error).toBeUndefined();
  await sequelize.query('DELETE FROM dbo.employee WHERE employee_id = :id', { replacements: { id: emp.employee_id } });

  const second = await recycleBinModel.restore(binRow.bin_id, 'jest');
  expect(second.error).toBe('already_restored');
});

test('restoring a nonexistent bin_id returns not_found', async () => {
  const result = await recycleBinModel.restore(999999999, 'jest');
  expect(result.error).toBe('not_found');
});

test('purge permanently removes a bin row and returns it', async () => {
  const emp = await employeeModel.create({ full_name: 'TEST-JEST-RECYCLE-PURGE-' + Date.now() });
  await employeeModel.remove(emp.employee_id, emp.full_name, { user_id: 1, username: 'jest' });
  const [binRow] = await sequelize.query(
    "SELECT bin_id FROM dbo.recycle_bin WHERE entity_type = 'employee' AND entity_id = :id ORDER BY bin_id DESC",
    { replacements: { id: emp.employee_id }, type: QueryTypes.SELECT },
  );

  const purged = await recycleBinModel.purge(binRow.bin_id);
  expect(purged.bin_id).toBe(binRow.bin_id);

  const [gone] = await sequelize.query('SELECT 1 FROM dbo.recycle_bin WHERE bin_id = :id', { replacements: { id: binRow.bin_id }, type: QueryTypes.SELECT });
  expect(gone).toBeUndefined();
  // No cleanup needed - purge already removed it, and the employee row
  // itself was never restored so there's nothing left in dbo.employee either.
});
