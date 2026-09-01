// DB-backed - see tests/README.md. Every row this file touches is created
// and deleted by the test itself; nothing here reads or modifies a real
// employee/equipment/borrow record.
//
// Regression coverage for a real latent bug found and fixed earlier in the
// sequelize-migration branch: BorrowRecord.borrower_id was declared
// allowNull:false in the Sequelize model even though the real column is
// nullable, which made employeeModel.remove() fail client-side (before ever
// reaching the database) for any employee with borrow history - see the
// comment on BorrowRecord.borrower_id in models/borrowModel.js. This test
// exists so that mistake (or an equivalent one) can't be silently
// reintroduced.
const sequelize = require('../../config/sequelize');
const { QueryTypes } = require('sequelize');
const employeeModel = require('../../models/employeeModel');
const equipmentModel = require('../../models/equipmentModel');
const borrowModel = require('../../models/borrowModel');

const scratchEquipmentIds = [];
const scratchEmployeeIds = [];

async function makeScratchEquipment(categoryId) {
  const equip = await equipmentModel.createStock({
    category_id: categoryId,
    device_type: 'Test',
    asset_code: 'TSTRM-JEST-' + Date.now().toString().slice(-6) + Math.floor(Math.random() * 1000),
  });
  scratchEquipmentIds.push(equip.equipment_id);
  return equip;
}

afterAll(async () => {
  for (const id of scratchEquipmentIds) {
    await sequelize.query('DELETE FROM dbo.borrow_record WHERE equipment_id = :id', { replacements: { id } });
    await sequelize.query('DELETE FROM dbo.equipment WHERE equipment_id = :id', { replacements: { id } });
  }
  for (const id of scratchEmployeeIds) {
    await sequelize.query('DELETE FROM dbo.employee WHERE employee_id = :id', { replacements: { id } });
    await sequelize.query("DELETE FROM dbo.recycle_bin WHERE entity_type = 'employee' AND entity_id = :id", { replacements: { id } });
  }
});

describe('employeeModel.remove()', () => {
  test('removing an employee with no borrow history succeeds', async () => {
    const emp = await employeeModel.create({ full_name: 'TEST-JEST-NOBORROW-' + Date.now() });
    const removed = await employeeModel.remove(emp.employee_id, emp.full_name, { user_id: 1, username: 'jest', role: 'admin' });
    expect(removed).toBe(true);

    const [stillThere] = await sequelize.query('SELECT 1 FROM dbo.employee WHERE employee_id = :id', { replacements: { id: emp.employee_id }, type: QueryTypes.SELECT });
    expect(stillThere).toBeUndefined();
  });

  test('removing an employee with open borrow history succeeds and snapshots the name', async () => {
    const [category] = await sequelize.query('SELECT TOP 1 category_id FROM dbo.category WHERE is_active = 1', { type: QueryTypes.SELECT });
    const emp = await employeeModel.create({ full_name: 'TEST-JEST-BORROWER-' + Date.now() });
    scratchEmployeeIds.push(emp.employee_id); // in case the assertions below fail before remove() runs
    const equip = await makeScratchEquipment(category.category_id);

    const loan = await borrowModel.create({
      equipment_id: equip.equipment_id,
      borrower_id: emp.employee_id,
      borrow_date: new Date().toISOString().slice(0, 10),
    });

    // This is the exact call that used to throw client-side before the
    // allowNull fix - it must not throw here.
    const removed = await employeeModel.remove(emp.employee_id, emp.full_name, { user_id: 1, username: 'jest', role: 'admin' });
    expect(removed).toBe(true);

    const [borrowAfter] = await sequelize.query(
      'SELECT borrower_id, borrower_name FROM dbo.borrow_record WHERE borrow_id = :id',
      { replacements: { id: loan.borrow_id }, type: QueryTypes.SELECT },
    );
    expect(borrowAfter.borrower_id).toBeNull();
    expect(borrowAfter.borrower_name).toBe(emp.full_name);

    const [employeeGone] = await sequelize.query('SELECT 1 FROM dbo.employee WHERE employee_id = :id', { replacements: { id: emp.employee_id }, type: QueryTypes.SELECT });
    expect(employeeGone).toBeUndefined();

    const [binRow] = await sequelize.query(
      "SELECT 1 FROM dbo.recycle_bin WHERE entity_type = 'employee' AND entity_id = :id",
      { replacements: { id: emp.employee_id }, type: QueryTypes.SELECT },
    );
    expect(binRow).toBeDefined();
  });

  test('removing a nonexistent employee returns false', async () => {
    const removed = await employeeModel.remove(999999999, 'nobody', { user_id: 1, username: 'jest' });
    expect(removed).toBe(false);
  });
});
