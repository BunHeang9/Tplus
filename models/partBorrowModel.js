const { DataTypes, Op } = require('sequelize');
const sequelize = require('../config/sequelize');
const { QueryTypes } = require('sequelize');
const partStockModel = require('../models/partStockModel');
const { PartStock, PartType } = partStockModel;
const { Employee } = require('./employeeModel');
const { Department } = require('./departmentModel');
const { ApiUser } = require('./userModel');

// Temporary loans of individual parts out of part_stock (dbo.part_borrow_record).
//
// Mirrors borrowModel.js exactly, one level down: that loans a whole
// dbo.equipment row (always qty 1, tracked by flipping its status); this
// loans some quantity off a dbo.part_stock line, tracked by decrementing and
// later restoring that line's quantity - a stock line has no status to flip,
// and can lend out 2 of 5 without taking the rest out of circulation. That
// difference is also why this stays a separate table and endpoints rather
// than reusing /api/borrow: equipment_id there always means exactly one
// item, and bolting a quantity onto it would leave every existing row and
// query implicitly assuming 1 anyway.

// Borrow eligibility used to be a hardcoded "status must equal exactly
// 'Working - IT Stock'" check - now driven by part_stock_status.is_borrowable
// instead (partStatusModel.js), the same way equipment's own borrow
// eligibility already works off equipment_status.is_borrowable. See
// partBorrowController.js's borrow() for where that's actually checked.

// Defined here (not in partStockModel.js) and pointing outward at
// PartStock/Employee/ApiUser via belongsTo only - same reasoning as
// borrowModel.js's BorrowRecord: partStockModel.js never needs to know about
// loans, so this avoids the circular require that a reverse
// PartStock.hasMany(PartBorrowRecord) would create.
const PartBorrowRecord = sequelize.define('PartBorrowRecord', {
  borrow_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  stock_id: { type: DataTypes.INTEGER, allowNull: false },
  quantity: { type: DataTypes.INTEGER, allowNull: false },
  borrower_id: { type: DataTypes.INTEGER, allowNull: false },
  borrow_date: { type: DataTypes.DATEONLY, allowNull: false },
  expected_return_date: { type: DataTypes.DATEONLY, allowNull: true },
  return_date: { type: DataTypes.DATEONLY, allowNull: true },
  condition_on_borrow: { type: DataTypes.STRING(400), allowNull: true },
  condition_on_return: { type: DataTypes.STRING(400), allowNull: true },
  issued_by_id: { type: DataTypes.INTEGER, allowNull: true },
  received_by_id: { type: DataTypes.INTEGER, allowNull: true },
  purpose: { type: DataTypes.STRING(400), allowNull: true },
  remark: { type: DataTypes.STRING(400), allowNull: true },
  // Legacy DATETIME with its own DB-side default - allowNull:true here even
  // though the column itself is NOT NULL, same pattern as borrowModel.js's
  // BorrowRecord.created_at: create() never sets this field, so Sequelize's
  // client-side validation would otherwise reject the insert before the DB
  // default ever gets a chance to run.
  created_at: { type: DataTypes.DATE, allowNull: true },
}, {
  tableName: 'part_borrow_record',
  schema: 'dbo',
  timestamps: false,
});

PartBorrowRecord.belongsTo(PartStock, { foreignKey: 'stock_id', as: 'stock' });
PartBorrowRecord.belongsTo(Employee, { foreignKey: 'borrower_id', as: 'borrower' });
PartBorrowRecord.belongsTo(ApiUser, { foreignKey: 'issued_by_id', as: 'issuer' });
PartBorrowRecord.belongsTo(ApiUser, { foreignKey: 'received_by_id', as: 'receiver' });

// Shared include set for every read below: stock (with its part type),
// borrower (with department), issuer/receiver - mirrors
// borrowModel.js's repeated include block, and equipmentModel.js's
// equipmentIncludes() helper for the same "used by several functions"
// reason.
function partBorrowIncludes() {
  return [
    { model: PartStock, as: 'stock', required: true, include: [{ model: PartType, as: 'partType' }] },
    { model: Employee, as: 'borrower', required: true, include: [{ model: Department, as: 'department' }] },
    { model: ApiUser, as: 'issuer' },
    { model: ApiUser, as: 'receiver' },
  ];
}

// Raw queries with no model attribute definition return a plain string for a
// DATE/DATETIME column; the driver this replaces returned a Date object for
// the same column. Converting back keeps every response identical to before
// this migration. Still needed even on the ORM path - DATEONLY reads back as
// a string through the ORM too, the same trade-off already made (and
// approved) for equipmentModel.js's findAll/findById.
const DATE_FIELDS = ['borrow_date', 'expected_return_date', 'return_date', 'created_at'];
function fixDates(row) {
  if (!row) return row;
  for (const f of DATE_FIELDS) {
    if (row[f]) row[f] = new Date(row[f]);
  }
  return row;
}

// Everything needed to decide whether this line has enough to lend out. Two
// separate ORM reads (the stock row, and its currently-borrowed total)
// merged in JS - same "single-row lookup, not a list" reasoning as
// borrowModel.findEquipmentForBorrow. sum() is a real Sequelize aggregate
// method, not a raw query.
async function findStockForBorrow(stockId) {
  const stock = await PartStock.findByPk(stockId, {
    include: [{ model: PartType, as: 'partType', attributes: ['part_name'] }],
  });
  if (!stock) return null;
  const s = stock.get({ plain: true });

  const currentlyBorrowed = await PartBorrowRecord.sum('quantity', {
    where: { stock_id: stockId, return_date: null },
  });

  return {
    stock_id: s.stock_id,
    part_type_id: s.part_type_id,
    quantity: s.quantity,
    status: s.status,
    part_name: s.partType ? s.partType.part_name : null,
    part_value: s.part_value,
    model_name: s.model_name,
    model_number: s.model_number,
    currently_borrowed: currentlyBorrowed || 0,
  };
}

// Creating the loan and taking the quantity off the shelf happen together in
// a transaction - if either fails, neither is applied. decrement() already
// refuses to go below zero, so an over-ask surfaces as null here rather than
// a negative quantity slipping through. Self-contained now that
// partStockModel.decrement() itself takes a Sequelize transaction.
async function create(d) {
  return sequelize.transaction(async (transaction) => {
    const decremented = await partStockModel.decrement(d.stock_id, d.quantity, transaction);
    if (!decremented) return { error: 'insufficient_stock' };

    const row = await PartBorrowRecord.create({
      stock_id: d.stock_id,
      quantity: d.quantity,
      borrower_id: d.borrower_id,
      borrow_date: d.borrow_date,
      expected_return_date: d.expected_return_date || null,
      condition_on_borrow: d.condition_on_borrow || null,
      issued_by_id: d.issued_by_id || null,
      purpose: d.purpose || null,
      remark: d.remark || null,
    }, { transaction });

    return fixDates(row.get({ plain: true }));
  });
}

async function findById(borrowId) {
  const row = await PartBorrowRecord.findByPk(borrowId, { include: partBorrowIncludes() });
  if (!row) return null;

  const { stock, borrower, issuer, receiver, ...b } = row.get({ plain: true });
  const borrowerDept = borrower.department;
  return fixDates({
    borrow_id: b.borrow_id,
    stock_id: b.stock_id,
    quantity: b.quantity,
    part_name: stock.partType ? stock.partType.part_name : null,
    part_value: stock.part_value,
    model_name: stock.model_name,
    model_number: stock.model_number,
    disk_type: stock.disk_type,
    disk_interface: stock.disk_interface,
    ram_type: stock.ram_type,
    borrower_id: b.borrower_id,
    borrower_name: borrower.full_name,
    borrower_department: borrowerDept ? borrowerDept.department_code : null,
    borrow_date: b.borrow_date,
    expected_return_date: b.expected_return_date,
    return_date: b.return_date,
    condition_on_borrow: b.condition_on_borrow,
    condition_on_return: b.condition_on_return,
    issued_by: issuer ? issuer.full_name : null,
    received_by: receiver ? receiver.full_name : null,
    purpose: b.purpose,
    remark: b.remark,
  });
}

// Closing the loan and putting the quantity back, in one transaction. If it
// came back in worse shape than it left (condition changed) or a different
// status was given, the quantity is routed through increment() instead of
// going straight back to this line - the same merge-or-create-a-line
// behaviour used everywhere else stock is added, so "3 Working out, 1 came
// back Broken" ends up on the Broken line rather than corrupting this one.
// Self-contained now that partStockModel.increment()/incrementById() take a
// Sequelize transaction.
async function markReturned(borrowId, d) {
  return sequelize.transaction(async (transaction) => {
    const values = {
      return_date: d.return_date,
      condition_on_return: d.condition_on_return || null,
    };
    if (d.received_by_id) values.received_by_id = d.received_by_id;
    if (d.remark) values.remark = d.remark;

    const [, [row]] = await PartBorrowRecord.update(values, {
      where: { borrow_id: borrowId, return_date: null },
      returning: true,
      transaction,
    });
    if (!row) return null;
    const loan = row.get({ plain: true });

    const stock = await PartStock.findByPk(loan.stock_id, { transaction, raw: true });

    if (d.return_status && d.return_status !== stock.status) {
      await partStockModel.increment(
        stock.part_type_id, stock.part_value, d.return_status, loan.quantity, transaction,
        {
          model_name: stock.model_name, model_number: stock.model_number,
          disk_type: stock.disk_type, disk_interface: stock.disk_interface,
          ram_type: stock.ram_type, location: stock.location,
        },
      );
    } else {
      await partStockModel.incrementById(loan.stock_id, loan.quantity, transaction);
    }

    return fixDates(loan);
  });
}

async function findCurrentlyBorrowed(overdueOnly) {
  // GETDATE() is the server's clock, not a column any include can filter or
  // sort by - one small raw call gets today's date once, then is_overdue is
  // computed in JS against every open loan fetched through the ORM below.
  const [{ today }] = await sequelize.query(
    'SELECT CAST(GETDATE() AS DATE) AS today', { type: QueryTypes.SELECT },
  );
  const todayMs = Date.parse(today);

  const rows = await PartBorrowRecord.findAll({ where: { return_date: null }, include: partBorrowIncludes() });

  let shaped = rows.map((row) => {
    const { stock, borrower, issuer, receiver, ...b } = row.get({ plain: true });
    const borrowerDept = borrower.department;
    const isOverdue = b.expected_return_date && Date.parse(b.expected_return_date) < todayMs;
    return fixDates({
      borrow_id: b.borrow_id,
      stock_id: b.stock_id,
      quantity: b.quantity,
      part_name: stock.partType ? stock.partType.part_name : null,
      part_value: stock.part_value,
      model_name: stock.model_name,
      model_number: stock.model_number,
      disk_type: stock.disk_type,
      disk_interface: stock.disk_interface,
      ram_type: stock.ram_type,
      borrower_id: b.borrower_id,
      borrower_name: borrower.full_name,
      borrower_department: borrowerDept ? borrowerDept.department_code : null,
      borrow_date: b.borrow_date,
      expected_return_date: b.expected_return_date,
      return_date: b.return_date,
      condition_on_borrow: b.condition_on_borrow,
      condition_on_return: b.condition_on_return,
      issued_by: issuer ? issuer.full_name : null,
      received_by: receiver ? receiver.full_name : null,
      purpose: b.purpose,
      remark: b.remark,
      is_overdue: isOverdue ? 1 : 0,
    });
  });

  if (overdueOnly === 'true') shaped = shaped.filter((r) => r.is_overdue === 1);
  shaped.sort((a, b) => (b.is_overdue - a.is_overdue) || (new Date(a.borrow_date) - new Date(b.borrow_date)));

  return shaped;
}

async function findHistory(filters = {}) {
  const { stock_id, borrower_id, from, to } = filters;

  const where = {};
  if (stock_id) where.stock_id = stock_id;
  if (borrower_id) where.borrower_id = borrower_id;
  if (from || to) {
    where.borrow_date = {};
    if (from) where.borrow_date[Op.gte] = from;
    if (to) where.borrow_date[Op.lte] = to;
  }

  const rows = await PartBorrowRecord.findAll({
    where,
    include: partBorrowIncludes(),
    order: [['borrow_date', 'DESC'], ['borrow_id', 'DESC']],
  });

  return rows.map((row) => {
    const { stock, borrower, issuer, receiver, ...b } = row.get({ plain: true });
    const borrowerDept = borrower.department;
    return fixDates({
      borrow_id: b.borrow_id,
      stock_id: b.stock_id,
      quantity: b.quantity,
      part_name: stock.partType ? stock.partType.part_name : null,
      part_value: stock.part_value,
      model_name: stock.model_name,
      model_number: stock.model_number,
      disk_type: stock.disk_type,
      disk_interface: stock.disk_interface,
      ram_type: stock.ram_type,
      borrower_id: b.borrower_id,
      borrower_name: borrower.full_name,
      borrower_department: borrowerDept ? borrowerDept.department_code : null,
      borrow_date: b.borrow_date,
      expected_return_date: b.expected_return_date,
      return_date: b.return_date,
      condition_on_borrow: b.condition_on_borrow,
      condition_on_return: b.condition_on_return,
      issued_by: issuer ? issuer.full_name : null,
      received_by: receiver ? receiver.full_name : null,
      purpose: b.purpose,
      remark: b.remark,
      loan_status: b.return_date === null ? 'Out' : 'Returned',
    });
  });
}

// Returned loans only, with days_kept/was_late worked out here rather than
// making the frontend calculate them - same pattern as
// borrowModel.findReturns (DATEDIFF isn't one of Sequelize's portable fn
// helpers, so this is computed in JS after the ORM read instead of inside
// the query).
async function findReturns(filters = {}) {
  const { stock_id, borrower_id, from, to, late_only } = filters;

  const where = { return_date: { [Op.ne]: null } };
  if (stock_id) where.stock_id = stock_id;
  if (borrower_id) where.borrower_id = borrower_id;
  if (from || to) {
    where.return_date = { ...where.return_date, ...(from ? { [Op.gte]: from } : {}), ...(to ? { [Op.lte]: to } : {}) };
  }

  const rows = await PartBorrowRecord.findAll({
    where,
    include: partBorrowIncludes(),
    order: [['return_date', 'DESC'], ['borrow_id', 'DESC']],
  });

  const dayMs = 24 * 60 * 60 * 1000;
  const toDay = (v) => (v ? Date.parse(String(v).slice(0, 10)) : null);

  const shaped = rows.map((row) => {
    const { stock, borrower, issuer, receiver, ...b } = row.get({ plain: true });
    const borrowerDept = borrower.department;
    const borrowDay = toDay(b.borrow_date);
    const returnDay = toDay(b.return_date);
    const expectedDay = toDay(b.expected_return_date);
    const wasLate = expectedDay !== null && returnDay > expectedDay;

    return fixDates({
      borrow_id: b.borrow_id,
      stock_id: b.stock_id,
      quantity: b.quantity,
      part_name: stock.partType ? stock.partType.part_name : null,
      part_value: stock.part_value,
      model_name: stock.model_name,
      model_number: stock.model_number,
      disk_type: stock.disk_type,
      disk_interface: stock.disk_interface,
      ram_type: stock.ram_type,
      borrower_id: b.borrower_id,
      borrower_name: borrower.full_name,
      borrower_department: borrowerDept ? borrowerDept.department_code : null,
      borrow_date: b.borrow_date,
      expected_return_date: b.expected_return_date,
      return_date: b.return_date,
      condition_on_borrow: b.condition_on_borrow,
      condition_on_return: b.condition_on_return,
      issued_by: issuer ? issuer.full_name : null,
      received_by: receiver ? receiver.full_name : null,
      purpose: b.purpose,
      remark: b.remark,
      days_kept: Math.round((returnDay - borrowDay) / dayMs),
      was_late: wasLate ? 1 : 0,
      days_late: wasLate ? Math.round((returnDay - expectedDay) / dayMs) : 0,
      _wasLate: wasLate,
    });
  });

  return late_only === 'true' ? shaped.filter((r) => r._wasLate).map(({ _wasLate, ...rest }) => rest) : shaped.map(({ _wasLate, ...rest }) => rest);
}

async function findByBorrower(borrowerId, openOnly) {
  const where = { borrower_id: borrowerId };
  if (openOnly === 'true') where.return_date = null;

  const rows = await PartBorrowRecord.findAll({
    where,
    include: partBorrowIncludes(),
    order: [['borrow_date', 'DESC']],
  });

  return rows.map((row) => {
    const { stock, borrower, issuer, receiver, ...b } = row.get({ plain: true });
    const borrowerDept = borrower.department;
    return fixDates({
      borrow_id: b.borrow_id,
      stock_id: b.stock_id,
      quantity: b.quantity,
      part_name: stock.partType ? stock.partType.part_name : null,
      part_value: stock.part_value,
      model_name: stock.model_name,
      model_number: stock.model_number,
      disk_type: stock.disk_type,
      disk_interface: stock.disk_interface,
      ram_type: stock.ram_type,
      borrower_id: b.borrower_id,
      borrower_name: borrower.full_name,
      borrower_department: borrowerDept ? borrowerDept.department_code : null,
      borrow_date: b.borrow_date,
      expected_return_date: b.expected_return_date,
      return_date: b.return_date,
      condition_on_borrow: b.condition_on_borrow,
      condition_on_return: b.condition_on_return,
      issued_by: issuer ? issuer.full_name : null,
      received_by: receiver ? receiver.full_name : null,
      purpose: b.purpose,
      remark: b.remark,
      loan_status: b.return_date === null ? 'Out' : 'Returned',
    });
  });
}

// Deleting a loan record is for correcting a mistaken entry, not erasing
// history. If it is still open the quantity has to go back on the shelf,
// otherwise it stays counted as out with nothing holding it. Self-contained
// now that partStockModel.incrementById() itself takes a Sequelize
// transaction.
async function remove(borrowId) {
  return sequelize.transaction(async (transaction) => {
    const row = await PartBorrowRecord.findByPk(borrowId, { transaction, raw: true });
    if (!row) return null;

    await PartBorrowRecord.destroy({ where: { borrow_id: borrowId }, transaction });

    if (!row.return_date) {
      await partStockModel.incrementById(row.stock_id, row.quantity, transaction);
    }

    return fixDates(row);
  });
}

module.exports = {
  findStockForBorrow,
  create,
  findById,
  markReturned,
  findCurrentlyBorrowed,
  findHistory,
  findReturns,
  findByBorrower,
  remove,
};
