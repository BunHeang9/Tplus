// DB-backed - see tests/README.md. Every account, part-stock line, and
// employee here is scratch-only, created and deleted by this file. The
// last-admin guard reuses userModel.countAdmins() unchanged from
// userController.update()'s own existing guard - this file verifies that
// counting logic directly with scratch admins rather than ever forcing the
// real system down to zero real admins, which would be too risky to do
// even temporarily.
const bcrypt = require('bcryptjs');
const { QueryTypes } = require('sequelize');
const sequelize = require('../../config/sequelize');
const userController = require('../../controllers/userController');
const userModel = require('../../models/userModel');
const partStockModel = require('../../models/partStockModel');
const partBorrowModel = require('../../models/partBorrowModel');
const employeeModel = require('../../models/employeeModel');

function fakeRes() {
  return { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}

async function makeAccount(role) {
  const passwordHash = await bcrypt.hash('ScratchPass123', 10);
  return userModel.create({
    username: 'TEST-JEST-USERRM-' + role + '-' + Date.now() + Math.floor(Math.random() * 1000),
    passwordHash, fullName: 'Test ' + role, role, isActive: true,
  });
}

async function callRemove(callerId, targetId) {
  const req = { params: { id: String(targetId) }, user: { user_id: callerId } };
  const res = fakeRes();
  await userController.remove(req, res, () => {});
  return res;
}

afterAll(async () => {
  // Anything left over from a failed assertion mid-test.
  await sequelize.query("DELETE FROM dbo.api_user WHERE username LIKE 'TEST-JEST-USERRM-%'");
});

test('deletes an unreferenced account and it is actually gone', async () => {
  const admin = await makeAccount('admin');
  const viewer = await makeAccount('viewer');

  const res = await callRemove(admin.user_id, viewer.user_id);
  expect(res.statusCode).toBeNull(); // 200 default, no explicit .status() call
  expect(res.body.message).toContain('deleted');

  const gone = await userModel.findById(viewer.user_id);
  expect(gone).toBeNull();

  await sequelize.query('DELETE FROM dbo.api_user WHERE user_id = :id', { replacements: { id: admin.user_id } });
});

test('refuses to delete your own account', async () => {
  const admin = await makeAccount('admin');

  const res = await callRemove(admin.user_id, admin.user_id);
  expect(res.statusCode).toBe(409);
  expect(res.body.error).toMatch(/cannot delete your own account/i);

  const stillThere = await userModel.findById(admin.user_id);
  expect(stillThere).not.toBeNull();

  await sequelize.query('DELETE FROM dbo.api_user WHERE user_id = :id', { replacements: { id: admin.user_id } });
});

test('returns 404 for a nonexistent user', async () => {
  const admin = await makeAccount('admin');
  const res = await callRemove(admin.user_id, 999999999);
  expect(res.statusCode).toBe(404);
  await sequelize.query('DELETE FROM dbo.api_user WHERE user_id = :id', { replacements: { id: admin.user_id } });
});

test('refuses to delete an account still referenced by part-loan history', async () => {
  const caller = await makeAccount('admin');
  const issuer = await makeAccount('admin');

  const [partType] = await sequelize.query('SELECT TOP 1 part_type_id FROM dbo.part_type', { type: QueryTypes.SELECT });
  const stock = await partStockModel.increment(partType.part_type_id, 'TEST-JEST-REF', 'Working - IT Stock', 3);
  const emp = await employeeModel.create({ full_name: 'TEST-JEST-USERRM-EMP-' + Date.now() });
  const loan = await partBorrowModel.create({
    stock_id: stock.stock_id, quantity: 1, borrower_id: emp.employee_id,
    borrow_date: new Date().toISOString().slice(0, 10), issued_by_id: issuer.user_id,
  });

  const res = await callRemove(caller.user_id, issuer.user_id);
  expect(res.statusCode).toBe(409);
  expect(res.body.references.issued_part_loans).toBe(1);

  const stillThere = await userModel.findById(issuer.user_id);
  expect(stillThere).not.toBeNull();

  await sequelize.query('DELETE FROM dbo.part_borrow_record WHERE borrow_id = :id', { replacements: { id: loan.borrow_id } });
  await sequelize.query('DELETE FROM dbo.part_stock WHERE stock_id = :id', { replacements: { id: stock.stock_id } });
  await sequelize.query('DELETE FROM dbo.employee WHERE employee_id = :id', { replacements: { id: emp.employee_id } });
  await sequelize.query('DELETE FROM dbo.api_user WHERE user_id IN (:caller, :issuer)', { replacements: { caller: caller.user_id, issuer: issuer.user_id } });
});

test('countAdmins correctly excludes the given id and inactive admins', async () => {
  const a = await makeAccount('admin');
  const b = await makeAccount('admin');

  const beforeDeactivate = await userModel.countAdmins(a.user_id);
  expect(beforeDeactivate).toBeGreaterThanOrEqual(1); // b, plus whatever real admins exist

  await sequelize.query('UPDATE dbo.api_user SET is_active = 0 WHERE user_id = :id', { replacements: { id: b.user_id } });
  const afterDeactivate = await userModel.countAdmins(a.user_id);
  expect(afterDeactivate).toBe(beforeDeactivate - 1); // b no longer counted

  await sequelize.query('DELETE FROM dbo.api_user WHERE user_id IN (:a, :b)', { replacements: { a: a.user_id, b: b.user_id } });
});
