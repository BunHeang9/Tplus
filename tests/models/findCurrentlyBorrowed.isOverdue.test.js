// DB-backed - see tests/README.md. Every row this file touches is created
// and deleted by the test itself.
//
// Regression coverage for a real bug reported by an actual user (not
// theoretical): is_overdue came back as SQL Server's own 0/1 - a
// non-technical frontend user was seeing a bare "1" rendered on screen
// with no idea what it meant. Fixed on both borrowModel.findCurrentlyBorrowed()
// (equipment) and partBorrowModel.findCurrentlyBorrowed() (parts) to return
// a real true/false instead - this file makes sure that stays true/false,
// not 1/0, for both an overdue and a not-yet-due loan.
const sequelize = require('../../config/sequelize');
const { QueryTypes } = require('sequelize');
const employeeModel = require('../../models/employeeModel');
const equipmentModel = require('../../models/equipmentModel');
const borrowModel = require('../../models/borrowModel');
const partModel = require('../../models/partModel');
const partStockModel = require('../../models/partStockModel');
const partBorrowModel = require('../../models/partBorrowModel');

let category;
const scratchEquipmentIds = [];
const scratchEmployeeIds = [];
const scratchPartTypeIds = [];

beforeAll(async () => {
  [category] = await sequelize.query('SELECT TOP 1 category_id FROM dbo.category WHERE is_active = 1', { type: QueryTypes.SELECT });
});

afterAll(async () => {
  // part_borrow_record (borrower_id -> employee) and borrow_record
  // (borrower_id -> employee, equipment_id -> equipment) both have to go
  // before the employee/equipment rows they reference, or the FK
  // constraint blocks the delete - caught by actually running this, not
  // assumed.
  for (const id of scratchPartTypeIds) {
    await sequelize.query('DELETE FROM dbo.part_borrow_record WHERE stock_id IN (SELECT stock_id FROM dbo.part_stock WHERE part_type_id = :id)', { replacements: { id } });
    await sequelize.query('DELETE FROM dbo.part_stock WHERE part_type_id = :id', { replacements: { id } });
    await sequelize.query('DELETE FROM dbo.part_type WHERE part_type_id = :id', { replacements: { id } });
  }
  for (const id of scratchEquipmentIds) {
    await sequelize.query('DELETE FROM dbo.borrow_record WHERE equipment_id = :id', { replacements: { id } });
    await sequelize.query('DELETE FROM dbo.equipment WHERE equipment_id = :id', { replacements: { id } });
  }
  for (const id of scratchEmployeeIds) {
    await sequelize.query('DELETE FROM dbo.employee WHERE employee_id = :id', { replacements: { id } });
  }
});

const ymd = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return ymd(d); };
const daysFromNow = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); };

describe('borrowModel.findCurrentlyBorrowed() - equipment', () => {
  test('is_overdue is a real boolean, true for a loan past its expected_return_date', async () => {
    const emp = await employeeModel.create({ full_name: 'TEST-JEST-OVERDUE-' + Date.now() });
    scratchEmployeeIds.push(emp.employee_id);
    const equip = await equipmentModel.createStock({
      category_id: category.category_id, device_type: 'Test', asset_code: 'TSTOD-JEST-' + Date.now().toString().slice(-6),
    });
    scratchEquipmentIds.push(equip.equipment_id);

    await borrowModel.create({
      equipment_id: equip.equipment_id,
      borrower_id: emp.employee_id,
      borrow_date: daysAgo(5),
      expected_return_date: daysAgo(2), // due 2 days ago - overdue
    });

    const rows = await borrowModel.findCurrentlyBorrowed();
    const row = rows.find((r) => r.equipment_id === equip.equipment_id);
    expect(row).toBeDefined();
    expect(row.is_overdue).toBe(true);
    expect(row.is_overdue).not.toBe(1); // the exact bug - it must not be the raw 1/0
  });

  test('is_overdue is false for a loan not yet due', async () => {
    const emp = await employeeModel.create({ full_name: 'TEST-JEST-NOTOVERDUE-' + Date.now() });
    scratchEmployeeIds.push(emp.employee_id);
    const equip = await equipmentModel.createStock({
      category_id: category.category_id, device_type: 'Test', asset_code: 'TSTND-JEST-' + Date.now().toString().slice(-6),
    });
    scratchEquipmentIds.push(equip.equipment_id);

    await borrowModel.create({
      equipment_id: equip.equipment_id,
      borrower_id: emp.employee_id,
      borrow_date: daysAgo(1),
      expected_return_date: daysFromNow(5), // due in the future
    });

    const rows = await borrowModel.findCurrentlyBorrowed();
    const row = rows.find((r) => r.equipment_id === equip.equipment_id);
    expect(row).toBeDefined();
    expect(row.is_overdue).toBe(false);
    expect(row.is_overdue).not.toBe(0);
  });

  test('overdue_count in the controller layer still counts correctly with the boolean form', async () => {
    // Guards the fix made alongside this one - borrowController.js used to
    // filter `r.is_overdue === 1`, which silently breaks (always 0) once
    // is_overdue became a real boolean. Exercised here at the model level
    // the same way the controller does it, since the controller itself
    // isn't hit by these DB-backed model tests.
    const rows = await borrowModel.findCurrentlyBorrowed();
    const overdueCount = rows.filter((r) => r.is_overdue).length;
    const trueCount = rows.filter((r) => r.is_overdue === true).length;
    expect(overdueCount).toBe(trueCount); // would diverge if is_overdue were ever 1/0 again
  });
});

describe('partBorrowModel.findCurrentlyBorrowed() - parts', () => {
  test('is_overdue is a real boolean for both an overdue and a not-yet-due part loan', async () => {
    const partType = await partModel.createType({
      part_name: 'TEST-JEST-PARTOVERDUE-' + Date.now(), equipment_column: null, tracks_value: false, is_countable: true,
    });
    scratchPartTypeIds.push(partType.part_type_id);
    const stock = await partStockModel.increment(partType.part_type_id, null, 'Working - IT Stock', 10);

    const emp = await employeeModel.create({ full_name: 'TEST-JEST-PARTBORROWER-' + Date.now() });
    scratchEmployeeIds.push(emp.employee_id);

    await partBorrowModel.create({
      stock_id: stock.stock_id, quantity: 2, borrower_id: emp.employee_id,
      borrow_date: daysAgo(10), expected_return_date: daysAgo(3), // overdue
    });
    await partBorrowModel.create({
      stock_id: stock.stock_id, quantity: 1, borrower_id: emp.employee_id,
      borrow_date: daysAgo(1), expected_return_date: daysFromNow(3), // not overdue
    });

    const rows = await partBorrowModel.findCurrentlyBorrowed();
    const forThisStock = rows.filter((r) => r.stock_id === stock.stock_id);
    expect(forThisStock).toHaveLength(2);

    const overdueRow = forThisStock.find((r) => r.is_overdue === true);
    const notOverdueRow = forThisStock.find((r) => r.is_overdue === false);
    expect(overdueRow).toBeDefined();
    expect(notOverdueRow).toBeDefined();
    // Neither should ever be the raw 1/0 this bug used to produce.
    expect(forThisStock.some((r) => r.is_overdue === 1 || r.is_overdue === 0)).toBe(false);
  });
});
