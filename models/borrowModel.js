const { DataTypes, Op } = require('sequelize');
const sequelize = require('../config/sequelize');
const { Equipment } = require('./equipmentModel');
const { Employee } = require('./employeeModel');
const { Department } = require('./departmentModel');
const { Category } = require('./categoryModel');
const { EquipmentStatus } = require('./statusModel');

// Temporary equipment loans (dbo.borrow_record).
//
//   equipment.owner_id  = permanent company-issued device
//   borrow_record       = temporary loan; item returns to stock afterwards
//
// Borrowing never touches owner_id. Whether something is currently out is
// always derived from return_date IS NULL, never stored as a flag, so the
// two can't drift apart.

const BORROWABLE_STATUS = 'Working - IT Stock';
const BORROWED_STATUS   = 'Borrowed';

// Defined here (not in equipmentModel.js) and pointing outward at
// Equipment/Employee via belongsTo only - equipmentModel.js never needs to
// know about BorrowRecord, so this avoids the circular require that would
// come from the reverse (Equipment.hasOne(BorrowRecord)) needing this file
// while this file also needs Equipment.
const BorrowRecord = sequelize.define('BorrowRecord', {
  borrow_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  equipment_id: { type: DataTypes.INTEGER, allowNull: false },
  // The real column is nullable (confirmed against sys.columns) - this is
  // set to NULL by employeeModel.remove() when the borrower's own employee
  // record is deleted (the name gets snapshotted onto borrower_name at the
  // same time). allowNull:false here would make that legitimate write fail
  // client-side before ever reaching the database - caught live.
  borrower_id: { type: DataTypes.INTEGER, allowNull: true },
  borrow_date: { type: DataTypes.DATEONLY, allowNull: true },
  expected_return_date: { type: DataTypes.DATEONLY, allowNull: true },
  return_date: { type: DataTypes.DATEONLY, allowNull: true },
  condition_on_borrow: { type: DataTypes.STRING(255), allowNull: true },
  condition_on_return: { type: DataTypes.STRING(255), allowNull: true },
  issued_by_id: { type: DataTypes.INTEGER, allowNull: true },
  received_by_id: { type: DataTypes.INTEGER, allowNull: true },
  remark: { type: DataTypes.STRING(255), allowNull: true },
  // Legacy DATETIME with its own DB-side default - same allowNull:true,
  // no-defaultValue pattern used everywhere else in this migration.
  created_at: { type: DataTypes.DATE, allowNull: true },
  // Name snapshots, only ever written by employeeModel.remove() when the
  // employee record itself is about to be deleted - not touched by
  // anything in this file, but findOpenLoanByEquipment's raw `SELECT *`
  // exposed them, so they're declared to keep that response shape intact.
  borrower_name: { type: DataTypes.STRING(255), allowNull: true },
  issued_by_name: { type: DataTypes.STRING(255), allowNull: true },
  received_by_name: { type: DataTypes.STRING(255), allowNull: true },
}, {
  tableName: 'borrow_record',
  schema: 'dbo',
  timestamps: false,
});

BorrowRecord.belongsTo(Equipment, { foreignKey: 'equipment_id', as: 'equipment' });
BorrowRecord.belongsTo(Employee, { foreignKey: 'borrower_id', as: 'borrower' });
BorrowRecord.belongsTo(Employee, { foreignKey: 'issued_by_id', as: 'issuer' });
BorrowRecord.belongsTo(Employee, { foreignKey: 'received_by_id', as: 'receiver' });

// Read-only mapping of the vw_currently_borrowed view (findCurrentlyBorrowed).
const CurrentlyBorrowedView = sequelize.define('CurrentlyBorrowedView', {
  borrow_id: { type: DataTypes.INTEGER, primaryKey: true },
  equipment_id: DataTypes.INTEGER,
  category_name: DataTypes.STRING(50),
  computer_name: DataTypes.STRING(100),
  device_model: DataTypes.STRING(100),
  asset_code: DataTypes.STRING(30),
  service_tag: DataTypes.STRING(100),
  borrower_id: DataTypes.INTEGER,
  borrower_name: DataTypes.STRING(150),
  borrower_department: DataTypes.STRING(50),
  borrow_date: DataTypes.DATEONLY,
  expected_return_date: DataTypes.DATEONLY,
  days_out: DataTypes.INTEGER,
  is_overdue: DataTypes.INTEGER,
  condition_on_borrow: DataTypes.STRING(255),
  remark: DataTypes.STRING(255),
}, {
  tableName: 'vw_currently_borrowed',
  schema: 'dbo',
  timestamps: false,
});

// Raw queries with no model attribute definition return a plain string for a
// DATE/DATETIME column; the driver this replaces returned a Date object for
// the same column. Converting back keeps every response identical to before
// this migration. Still needed even on the ORM path - DATEONLY reads back
// as a string through the ORM too, the same trade-off already made (and
// approved) for equipmentModel.js's findAll/findById.
const DATE_FIELDS = ['borrow_date', 'expected_return_date', 'return_date', 'created_at'];
function fixDates(row) {
  if (!row) return row;
  for (const f of DATE_FIELDS) {
    if (row[f]) row[f] = new Date(row[f]);
  }
  return row;
}

// Everything needed to decide whether this item can be lent out. Two
// separate ORM reads (the equipment row, and its open loan if any) merged
// in JS, rather than one JOIN - avoids needing Equipment to know about
// BorrowRecord at all (see the comment on BorrowRecord above), and this is
// a single-equipment lookup, not a list, so the extra round trip is free
// in practice.
async function findEquipmentForBorrow(equipmentId) {
  const equipment = await Equipment.findByPk(equipmentId, {
    include: [
      { model: Category, as: 'category' },
      { model: EquipmentStatus, as: 'equipmentStatus' },
      { model: Employee, as: 'owner' },
    ],
  });
  if (!equipment) return null;
  const e = equipment.get({ plain: true });

  const openLoan = await BorrowRecord.findOne({
    where: { equipment_id: equipmentId, return_date: null },
    order: [['borrow_date', 'DESC']],
    include: [{ model: Employee, as: 'borrower' }],
  });
  const loan = openLoan ? openLoan.get({ plain: true }) : null;

  return {
    equipment_id: e.equipment_id,
    owner_id: e.owner_id,
    status: e.status,
    is_borrowable: e.equipmentStatus ? e.equipmentStatus.is_borrowable : null,
    computer_name: e.computer_name,
    device_model: e.device_model,
    asset_code: e.asset_code,
    category_name: e.category ? e.category.category_name : null,
    current_owner: e.owner ? e.owner.full_name : null,
    open_borrow_id: loan ? loan.borrow_id : null,
    open_borrow_date: loan ? loan.borrow_date : null,
    current_borrower: loan && loan.borrower ? loan.borrower.full_name : null,
  };
}

// Creating the loan and flipping the equipment status happen together in a
// transaction. If either fails, neither is applied - so we never end up with
// a loan whose equipment still looks available, or vice versa. Self-contained
// (no external transaction interop), so this uses sequelize.transaction().
// Shared by create()/markReturned()/remove() below - equipmentModel.js's
// own assign()/unassignById() etc. resolve status_id the same way (a plain
// lookup, then Equipment.update()), once it turned out the "doesn't map
// onto Model.update()" reasoning only actually held for assignToEmployee()
// (which reads a THIRD table, dbo.employee, inside the same statement -
// no such cross-entity read here, just the equipment_status lookup).
async function flipEquipmentStatus(equipmentId, statusName, transaction) {
  const statusRow = await EquipmentStatus.findOne({
    where: { status_name: statusName }, attributes: ['status_id'], raw: true, transaction,
  });
  await Equipment.update(
    { status: statusName, status_id: statusRow ? statusRow.status_id : null },
    { where: { equipment_id: equipmentId }, transaction },
  );
}

async function create(d) {
  return sequelize.transaction(async (transaction) => {
    const row = await BorrowRecord.create({
      equipment_id: d.equipment_id,
      borrower_id: d.borrower_id,
      borrow_date: d.borrow_date,
      expected_return_date: d.expected_return_date || null,
      condition_on_borrow: d.condition_on_borrow || null,
      issued_by_id: d.issued_by_id || null,
      remark: d.remark || null,
    }, { transaction });

    await flipEquipmentStatus(d.equipment_id, BORROWED_STATUS, transaction);

    return fixDates(row.get({ plain: true }));
  });
}

async function findById(borrowId) {
  const row = await BorrowRecord.findByPk(borrowId, {
    include: [
      { model: Equipment, as: 'equipment', required: true, include: [{ model: Category, as: 'category' }] },
      { model: Employee, as: 'borrower', required: true },
    ],
  });
  if (!row) return null;

  const { equipment, borrower, issuer, receiver, ...b } = row.get({ plain: true });
  return fixDates({
    ...b,
    computer_name: equipment.computer_name,
    device_model: equipment.device_model,
    asset_code: equipment.asset_code,
    category_name: equipment.category ? equipment.category.category_name : null,
    borrower_name: borrower.full_name,
  });
}

// Lets the caller return an item by equipment_id without knowing the borrow_id.
async function findOpenLoanByEquipment(equipmentId) {
  const row = await BorrowRecord.findOne({
    where: { equipment_id: equipmentId, return_date: null },
    order: [['borrow_date', 'DESC']],
    raw: true,
  });
  return fixDates(row) || null;
}

// Closing the loan and returning the equipment to stock, in one transaction.
// If the item came back faulty the caller can pass return_status, e.g.
// 'Broken - IT Stock', instead of it going straight back into circulation.
// Self-contained, so this uses sequelize.transaction().
async function markReturned(borrowId, d) {
  return sequelize.transaction(async (transaction) => {
    const values = { return_date: d.return_date };
    if (d.condition_on_return !== undefined) values.condition_on_return = d.condition_on_return || null;
    if (d.received_by_id) values.received_by_id = d.received_by_id;
    if (d.remark) values.remark = d.remark;

    const [, [row]] = await BorrowRecord.update(values, {
      where: { borrow_id: borrowId },
      returning: true,
      transaction,
    });
    if (!row) return null;
    const returned = row.get({ plain: true });

    await flipEquipmentStatus(returned.equipment_id, d.return_status || BORROWABLE_STATUS, transaction);

    return fixDates(returned);
  });
}

async function findCurrentlyBorrowed(overdueOnly) {
  const rows = await CurrentlyBorrowedView.findAll({
    where: overdueOnly === 'true' ? { is_overdue: 1 } : undefined,
    order: [['is_overdue', 'DESC'], ['borrow_date', 'ASC']],
    raw: true,
  });
  // is_overdue comes back as SQL Server's own 0/1 (the view computes it via
  // a CASE WHEN...THEN 1 ELSE 0 END, not a real bit/boolean column) -
  // converted to a real true/false here, since a non-technical frontend
  // user was seeing the bare 1 rendered verbatim and had no idea what it
  // meant (real feedback, not theoretical). true/false behaves identically
  // to 1/0 in any JS truthy check, so this is a pure readability fix, not a
  // behavior change for any caller already doing `if (row.is_overdue)`.
  return rows.map((row) => ({ ...fixDates(row), is_overdue: !!row.is_overdue }));
}

async function findHistory(filters = {}) {
  const { equipment_id, borrower_id, from, to } = filters;

  const where = {};
  if (equipment_id) where.equipment_id = equipment_id;
  if (borrower_id) where.borrower_id = borrower_id;
  if (from || to) {
    where.borrow_date = {};
    if (from) where.borrow_date[Op.gte] = from;
    if (to) where.borrow_date[Op.lte] = to;
  }

  const rows = await BorrowRecord.findAll({
    where,
    include: [
      {
        model: Equipment, as: 'equipment', required: true,
        include: [{ model: Category, as: 'category' }],
      },
      {
        model: Employee, as: 'borrower', required: true,
        include: [{ model: Department, as: 'department' }],
      },
      { model: Employee, as: 'issuer' },
      { model: Employee, as: 'receiver' },
    ],
    order: [['borrow_date', 'DESC'], ['borrow_id', 'DESC']],
  });

  return rows.map((row) => {
    const { equipment, borrower, issuer, receiver, ...b } = row.get({ plain: true });
    const borrowerDept = borrower.department;
    return fixDates({
      borrow_id: b.borrow_id,
      equipment_id: b.equipment_id,
      category_name: equipment.category ? equipment.category.category_name : null,
      computer_name: equipment.computer_name,
      device_model: equipment.device_model,
      asset_code: equipment.asset_code,
      borrower_id: b.borrower_id,
      borrower_name: borrower.full_name,
      borrower_department: borrowerDept ? borrowerDept.department_code : null,
      borrow_date: b.borrow_date,
      expected_return_date: b.expected_return_date,
      return_date: b.return_date,
      loan_status: b.return_date === null ? 'In Use' : 'Returned',
      condition_on_borrow: b.condition_on_borrow,
      condition_on_return: b.condition_on_return,
      issued_by: issuer ? issuer.full_name : null,
      received_by: receiver ? receiver.full_name : null,
      remark: b.remark,
    });
  });
}

// Returned loans only - the Returns page. Newest first, and it works out
// days_kept and was_late here rather than making the frontend calculate them.
// DATEDIFF-based day counts stay computed in JS below instead of via
// sequelize.fn('DATEDIFF', ...) (mssql-specific, three-argument DATEDIFF
// isn't one of Sequelize's portable fn helpers) - same values, computed
// after the ORM read instead of inside the query.
async function findReturns(filters = {}) {
  const { equipment_id, borrower_id, from, to, late_only } = filters;

  const where = { return_date: { [Op.ne]: null } };
  if (equipment_id) where.equipment_id = equipment_id;
  if (borrower_id) where.borrower_id = borrower_id;
  if (from || to) {
    where.return_date = { ...where.return_date, ...(from ? { [Op.gte]: from } : {}), ...(to ? { [Op.lte]: to } : {}) };
  }

  const rows = await BorrowRecord.findAll({
    where,
    include: [
      {
        model: Equipment, as: 'equipment', required: true,
        include: [{ model: Category, as: 'category' }, { model: EquipmentStatus, as: 'equipmentStatus' }],
      },
      {
        model: Employee, as: 'borrower', required: true,
        include: [{ model: Department, as: 'department' }],
      },
      { model: Employee, as: 'issuer' },
      { model: Employee, as: 'receiver' },
    ],
    order: [['return_date', 'DESC'], ['borrow_id', 'DESC']],
  });

  const dayMs = 24 * 60 * 60 * 1000;
  const toDay = (v) => (v ? Date.parse(String(v).slice(0, 10)) : null);

  const shaped = rows.map((row) => {
    const { equipment, borrower, issuer, receiver, ...b } = row.get({ plain: true });
    const borrowerDept = borrower.department;
    const borrowDay = toDay(b.borrow_date);
    const returnDay = toDay(b.return_date);
    const expectedDay = toDay(b.expected_return_date);
    const wasLate = expectedDay !== null && returnDay > expectedDay;

    return fixDates({
      borrow_id: b.borrow_id,
      equipment_id: b.equipment_id,
      category_name: equipment.category ? equipment.category.category_name : null,
      computer_name: equipment.computer_name,
      device_model: equipment.device_model,
      asset_code: equipment.asset_code,
      service_tag: equipment.service_tag,
      borrower_id: b.borrower_id,
      borrower_name: borrower.full_name,
      borrower_position: borrower.position,
      borrower_department: borrowerDept ? borrowerDept.department_code : null,
      borrow_date: b.borrow_date,
      expected_return_date: b.expected_return_date,
      return_date: b.return_date,
      days_kept: Math.round((returnDay - borrowDay) / dayMs),
      was_late: wasLate ? 1 : 0,
      days_late: wasLate ? Math.round((returnDay - expectedDay) / dayMs) : 0,
      condition_on_borrow: b.condition_on_borrow,
      condition_on_return: b.condition_on_return,
      current_status: equipment.equipmentStatus ? equipment.equipmentStatus.status_name : null,
      issued_by: issuer ? issuer.full_name : null,
      received_by: receiver ? receiver.full_name : null,
      remark: b.remark,
      _wasLate: wasLate,
    });
  });

  return late_only === 'true' ? shaped.filter((r) => r._wasLate).map(({ _wasLate, ...rest }) => rest) : shaped.map(({ _wasLate, ...rest }) => rest);
}

// What can be borrowed right now: correct status, and not already out. The
// "not already out" check is a NOT EXISTS correlated subquery in the
// original against the whole borrow_record table - fetched separately here
// (every equipment_id currently on an open loan) and excluded via
// Op.notIn, same "merge separate ORM reads in JS" pattern used throughout
// this migration for a correlated check that isn't a fit for a plain join.
async function findAvailableToBorrow(category) {
  const openLoans = await BorrowRecord.findAll({
    where: { return_date: null }, attributes: ['equipment_id'], raw: true,
  });
  const borrowedIds = openLoans.map((r) => r.equipment_id);

  const where = {};
  if (borrowedIds.length > 0) where.equipment_id = { [Op.notIn]: borrowedIds };

  const categoryInclude = { model: Category, as: 'category', attributes: ['category_name'] };
  if (category) {
    categoryInclude.where = { category_name: category };
    categoryInclude.required = true;
  }

  const rows = await Equipment.findAll({
    where,
    attributes: ['equipment_id', 'category_id', 'device_type', 'computer_name', 'device_model', 'manufacturer', 'asset_code', 'service_tag', 'location', 'status'],
    include: [
      categoryInclude,
      { model: EquipmentStatus, as: 'equipmentStatus', attributes: [], where: { is_borrowable: true }, required: true },
    ],
    order: [[{ model: Category, as: 'category' }, 'category_name', 'ASC'], ['equipment_id', 'ASC']],
    subQuery: false,
  });

  return rows.map((row) => {
    const { category: cat, equipmentStatus, ...e } = row.get({ plain: true });
    return {
      equipment_id: e.equipment_id,
      category_id: e.category_id,
      category_name: cat ? cat.category_name : null,
      device_type: e.device_type,
      computer_name: e.computer_name,
      device_model: e.device_model,
      manufacturer: e.manufacturer,
      asset_code: e.asset_code,
      service_tag: e.service_tag,
      location: e.location,
      status: e.status,
    };
  });
}

async function findByBorrower(borrowerId, openOnly) {
  const where = { borrower_id: borrowerId };
  if (openOnly === 'true') where.return_date = null;

  const rows = await BorrowRecord.findAll({
    where,
    include: [{ model: Equipment, as: 'equipment', required: true, include: [{ model: Category, as: 'category' }] }],
    order: [['borrow_date', 'DESC']],
  });

  return rows.map((row) => {
    const { equipment, ...b } = row.get({ plain: true });
    return fixDates({
      borrow_id: b.borrow_id,
      equipment_id: b.equipment_id,
      category_name: equipment.category ? equipment.category.category_name : null,
      computer_name: equipment.computer_name,
      device_model: equipment.device_model,
      asset_code: equipment.asset_code,
      borrow_date: b.borrow_date,
      expected_return_date: b.expected_return_date,
      return_date: b.return_date,
      loan_status: b.return_date === null ? 'In Use' : 'Returned',
      condition_on_borrow: b.condition_on_borrow,
      condition_on_return: b.condition_on_return,
      remark: b.remark,
    });
  });
}

// Deleting a loan record is for correcting a mistaken entry, not for erasing
// history. If the loan is still open the equipment status has to be put back,
// otherwise the item would stay marked Borrowed with nothing holding it.
// Self-contained transaction, so this uses sequelize.transaction().
async function remove(borrowId) {
  return sequelize.transaction(async (transaction) => {
    const row = await BorrowRecord.findByPk(borrowId, { transaction, raw: true });
    if (!row) return null;

    await BorrowRecord.destroy({ where: { borrow_id: borrowId }, transaction });

    if (!row.return_date) {
      await flipEquipmentStatus(row.equipment_id, BORROWABLE_STATUS, transaction);
    }

    return fixDates(row);
  });
}

module.exports = {
  BorrowRecord, // exported so equipmentModel.js can count references
  // against this same table definition (countReferences()) via a lazy
  // require, rather than a raw correlated subquery.
  BORROWABLE_STATUS,
  remove,
  findEquipmentForBorrow,
  create,
  findById,
  findOpenLoanByEquipment,
  markReturned,
  findCurrentlyBorrowed,
  findHistory,
  findReturns,
  findAvailableToBorrow,
  findByBorrower,
};
