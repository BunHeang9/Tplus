// DB-backed - see tests/README.md. Scratch employee/equipment/antivirus
// records only.
//
// Covers the two real things this migration changed about searchAll():
// a live duplicate-row bug (a device with more than one antivirus_install
// record used to come back twice) and previously-undefined tie order
// (two rows tied on both owner_name and computer_name used to reshuffle
// between requests) now being deterministic.
const sequelize = require('../../config/sequelize');
const { QueryTypes } = require('sequelize');
const searchModel = require('../../models/searchModel');
const employeeModel = require('../../models/employeeModel');
const equipmentModel = require('../../models/equipmentModel');

let category;
let emp;
let equip;

beforeAll(async () => {
  [category] = await sequelize.query('SELECT TOP 1 category_id FROM dbo.category WHERE is_active = 1', { type: QueryTypes.SELECT });
  emp = await employeeModel.create({ full_name: 'TEST-JEST-SEARCH-' + Date.now() });
  equip = await equipmentModel.createStock({
    category_id: category.category_id, device_type: 'Test',
    computer_name: 'TEST-JEST-SEARCH-PC-' + Date.now(),
    asset_code: 'TSTSEARCH-JEST-' + Date.now().toString().slice(-6),
  });
  await equipmentModel.updateOwner(equip.equipment_id, emp.employee_id);
});

afterAll(async () => {
  await sequelize.query('DELETE FROM dbo.antivirus_install WHERE equipment_id = :id', { replacements: { id: equip.equipment_id } });
  await sequelize.query('DELETE FROM dbo.equipment WHERE equipment_id = :id', { replacements: { id: equip.equipment_id } });
  await sequelize.query('DELETE FROM dbo.employee WHERE employee_id = :id', { replacements: { id: emp.employee_id } });
});

test('a device with two antivirus_install records appears exactly once', async () => {
  // Two install records for the same device is a legitimate, accepted
  // scenario (reinstall history - see antivirusInstallModel.js) - this is
  // exactly the shape that used to produce a duplicate search result.
  await sequelize.query(
    "INSERT INTO dbo.antivirus_install (equipment_id, antivirus_status, plan_date) VALUES (:id, 'Installed', '2020-01-01')",
    { replacements: { id: equip.equipment_id } },
  );
  await sequelize.query(
    "INSERT INTO dbo.antivirus_install (equipment_id, antivirus_status, plan_date) VALUES (:id, 'Not Installed', '2026-01-01')",
    { replacements: { id: equip.equipment_id } },
  );

  const results = await searchModel.searchAll(emp.full_name);
  const matches = results.filter((r) => r.equipment_id === equip.equipment_id);
  expect(matches.length).toBe(1);
});

test('the result set includes both the equipment match and the employee themself where applicable', async () => {
  const results = await searchModel.searchAll(emp.full_name);
  expect(results.some((r) => r.match_type === 'Equipment' && r.equipment_id === equip.equipment_id)).toBe(true);
  // This employee owns equipment, so they should NOT also appear as a
  // separate "Employee" match_type row (that's reserved for employees who
  // own nothing).
  expect(results.some((r) => r.match_type === 'Employee' && r.employee_id === emp.employee_id)).toBe(false);
});

test('an employee who owns nothing appears as a standalone Employee match', async () => {
  const lonelyEmp = await employeeModel.create({ full_name: 'TEST-JEST-SEARCH-LONELY-' + Date.now() });
  try {
    const results = await searchModel.searchAll(lonelyEmp.full_name);
    const match = results.find((r) => r.employee_id === lonelyEmp.employee_id);
    expect(match).toBeDefined();
    expect(match.match_type).toBe('Employee');
  } finally {
    await sequelize.query('DELETE FROM dbo.employee WHERE employee_id = :id', { replacements: { id: lonelyEmp.employee_id } });
  }
});

test('results for a repeated identical query are byte-for-byte identical (deterministic order)', async () => {
  const first = await searchModel.searchAll('a');
  const second = await searchModel.searchAll('a');
  expect(JSON.stringify(second)).toBe(JSON.stringify(first));
});

test('a guaranteed-no-match term returns an empty array', async () => {
  const results = await searchModel.searchAll('ZZZZ-NO-SUCH-TERM-EXISTS-9999');
  expect(results).toEqual([]);
});
