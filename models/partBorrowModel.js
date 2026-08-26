const { sql, poolPromise } = require('../config/db');
const partStockModel = require('../models/partStockModel');

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

const AVAILABLE_STATUS = 'Working - IT Stock';

function selectFields(alias = 'b') {
  return `
    ${alias}.borrow_id, ${alias}.stock_id, ${alias}.quantity,
    pt.part_name, s.part_value, s.model_name, s.model_number,
    s.disk_type, s.disk_interface, s.ram_type,
    ${alias}.borrower_id, emp.full_name AS borrower_name,
    d.department_code AS borrower_department,
    ${alias}.borrow_date, ${alias}.expected_return_date, ${alias}.return_date,
    ${alias}.condition_on_borrow, ${alias}.condition_on_return,
    issuer.full_name   AS issued_by,
    receiver.full_name AS received_by,
    ${alias}.purpose, ${alias}.remark
  `;
}

function joins(alias = 'b') {
  return `
    JOIN dbo.part_stock s        ON ${alias}.stock_id = s.stock_id
    JOIN dbo.part_type pt        ON s.part_type_id = pt.part_type_id
    JOIN dbo.employee emp        ON ${alias}.borrower_id = emp.employee_id
    LEFT JOIN dbo.department d   ON emp.department_id = d.department_id
    LEFT JOIN dbo.api_user issuer   ON ${alias}.issued_by_id = issuer.user_id
    LEFT JOIN dbo.api_user receiver ON ${alias}.received_by_id = receiver.user_id
  `;
}

// Everything needed to decide whether this line has enough to lend out.
async function findStockForBorrow(stockId) {
  const pool = await poolPromise;
  const result = await pool.request().input('id', sql.Int, stockId).query(`
    SELECT s.stock_id, s.part_type_id, s.quantity, s.status,
           pt.part_name, s.part_value, s.model_name, s.model_number,
           (SELECT ISNULL(SUM(quantity), 0) FROM dbo.part_borrow_record
             WHERE stock_id = s.stock_id AND return_date IS NULL) AS currently_borrowed
    FROM dbo.part_stock s
    JOIN dbo.part_type pt ON s.part_type_id = pt.part_type_id
    WHERE s.stock_id = @id
  `);
  return result.recordset[0] || null;
}

// Creating the loan and taking the quantity off the shelf happen together in
// a transaction - if either fails, neither is applied. decrement() already
// refuses to go below zero, so an over-ask surfaces as null here rather than
// a negative quantity slipping through.
async function create(d) {
  const pool = await poolPromise;
  const transaction = new sql.Transaction(pool);
  await transaction.begin();

  try {
    const decremented = await partStockModel.decrement(d.stock_id, d.quantity, transaction);
    if (!decremented) {
      await transaction.rollback();
      return { error: 'insufficient_stock' };
    }

    const insert = await new sql.Request(transaction)
      .input('stock_id', sql.Int, d.stock_id)
      .input('quantity', sql.Int, d.quantity)
      .input('borrower_id', sql.Int, d.borrower_id)
      .input('borrow_date', sql.Date, d.borrow_date)
      .input('expected_return_date', sql.Date, d.expected_return_date || null)
      .input('condition_on_borrow', sql.NVarChar, d.condition_on_borrow || null)
      .input('issued_by_id', sql.Int, d.issued_by_id || null)
      .input('purpose', sql.NVarChar, d.purpose || null)
      .input('remark', sql.NVarChar, d.remark || null)
      .query(`
        INSERT INTO dbo.part_borrow_record (
          stock_id, quantity, borrower_id, borrow_date, expected_return_date,
          condition_on_borrow, issued_by_id, purpose, remark
        )
        OUTPUT INSERTED.*
        VALUES (
          @stock_id, @quantity, @borrower_id, @borrow_date, @expected_return_date,
          @condition_on_borrow, @issued_by_id, @purpose, @remark
        )
      `);

    await transaction.commit();
    return insert.recordset[0];
  } catch (err) {
    try { await transaction.rollback(); } catch { /* already rolled back */ }
    throw err;
  }
}

async function findById(borrowId) {
  const pool = await poolPromise;
  const result = await pool.request().input('id', sql.Int, borrowId).query(`
    SELECT ${selectFields()}
    FROM dbo.part_borrow_record b
    ${joins()}
    WHERE b.borrow_id = @id
  `);
  return result.recordset[0] || null;
}

// Closing the loan and putting the quantity back, in one transaction. If it
// came back in worse shape than it left (condition changed) or a different
// status was given, the quantity is routed through increment() instead of
// going straight back to this line - the same merge-or-create-a-line
// behaviour used everywhere else stock is added, so "3 Working out, 1 came
// back Broken" ends up on the Broken line rather than corrupting this one.
async function markReturned(borrowId, d) {
  const pool = await poolPromise;
  const transaction = new sql.Transaction(pool);
  await transaction.begin();

  try {
    const update = await new sql.Request(transaction)
      .input('id', sql.Int, borrowId)
      .input('return_date', sql.Date, d.return_date)
      .input('condition_on_return', sql.NVarChar, d.condition_on_return || null)
      .input('received_by_id', sql.Int, d.received_by_id || null)
      .input('remark', sql.NVarChar, d.remark || null)
      .query(`
        UPDATE dbo.part_borrow_record
        SET return_date         = @return_date,
            condition_on_return = @condition_on_return,
            received_by_id      = COALESCE(@received_by_id, received_by_id),
            remark              = COALESCE(@remark, remark)
        OUTPUT INSERTED.*
        WHERE borrow_id = @id AND return_date IS NULL
      `);

    const loan = update.recordset[0];
    if (!loan) {
      await transaction.rollback();
      return null;
    }

    const stockRow = await new sql.Request(transaction)
      .input('id', sql.Int, loan.stock_id)
      .query('SELECT * FROM dbo.part_stock WHERE stock_id = @id');
    const stock = stockRow.recordset[0];

    if (d.return_status && d.return_status !== stock.status) {
      await partStockModel.increment(
        stock.part_type_id, stock.part_value, d.return_status, loan.quantity, transaction,
        {
          model_name: stock.model_name, model_number: stock.model_number,
          disk_type: stock.disk_type, disk_interface: stock.disk_interface,
          ram_type: stock.ram_type, location: stock.location,
        }
      );
    } else {
      await partStockModel.incrementById(loan.stock_id, loan.quantity, transaction);
    }

    await transaction.commit();
    return loan;
  } catch (err) {
    try { await transaction.rollback(); } catch { /* already rolled back */ }
    throw err;
  }
}

async function findCurrentlyBorrowed(overdueOnly) {
  const pool = await poolPromise;
  let query = `
    SELECT ${selectFields()},
           CASE
             WHEN b.expected_return_date IS NOT NULL AND b.expected_return_date < CAST(GETDATE() AS DATE)
             THEN 1 ELSE 0
           END AS is_overdue
    FROM dbo.part_borrow_record b
    ${joins()}
    WHERE b.return_date IS NULL
  `;
  if (overdueOnly === 'true') {
    query += ' AND b.expected_return_date IS NOT NULL AND b.expected_return_date < CAST(GETDATE() AS DATE)';
  }
  query += ' ORDER BY is_overdue DESC, b.borrow_date';

  const result = await pool.request().query(query);
  return result.recordset;
}

async function findHistory(filters = {}) {
  const { stock_id, borrower_id, from, to } = filters;
  const pool = await poolPromise;
  const request = pool.request();

  let query = `
    SELECT ${selectFields()},
           CASE WHEN b.return_date IS NULL THEN 'Out' ELSE 'Returned' END AS loan_status
    FROM dbo.part_borrow_record b
    ${joins()}
    WHERE 1=1
  `;

  if (stock_id) {
    query += ' AND b.stock_id = @stock_id';
    request.input('stock_id', sql.Int, stock_id);
  }
  if (borrower_id) {
    query += ' AND b.borrower_id = @borrower_id';
    request.input('borrower_id', sql.Int, borrower_id);
  }
  if (from) {
    query += ' AND b.borrow_date >= @from';
    request.input('from', sql.Date, from);
  }
  if (to) {
    query += ' AND b.borrow_date <= @to';
    request.input('to', sql.Date, to);
  }

  query += ' ORDER BY b.borrow_date DESC, b.borrow_id DESC';

  const result = await request.query(query);
  return result.recordset;
}

// Returned loans only, with days_kept/was_late worked out here rather than
// making the frontend calculate them - same pattern as borrowModel.findReturns.
async function findReturns(filters = {}) {
  const { stock_id, borrower_id, from, to, late_only } = filters;
  const pool = await poolPromise;
  const request = pool.request();

  let query = `
    SELECT ${selectFields()},
           DATEDIFF(DAY, b.borrow_date, b.return_date) AS days_kept,
           CASE
             WHEN b.expected_return_date IS NOT NULL AND b.return_date > b.expected_return_date
             THEN 1 ELSE 0
           END AS was_late,
           CASE
             WHEN b.expected_return_date IS NOT NULL AND b.return_date > b.expected_return_date
             THEN DATEDIFF(DAY, b.expected_return_date, b.return_date)
             ELSE 0
           END AS days_late
    FROM dbo.part_borrow_record b
    ${joins()}
    WHERE b.return_date IS NOT NULL
  `;

  if (stock_id) {
    query += ' AND b.stock_id = @stock_id';
    request.input('stock_id', sql.Int, stock_id);
  }
  if (borrower_id) {
    query += ' AND b.borrower_id = @borrower_id';
    request.input('borrower_id', sql.Int, borrower_id);
  }
  if (from) {
    query += ' AND b.return_date >= @from';
    request.input('from', sql.Date, from);
  }
  if (to) {
    query += ' AND b.return_date <= @to';
    request.input('to', sql.Date, to);
  }
  if (late_only === 'true') {
    query += ' AND b.expected_return_date IS NOT NULL AND b.return_date > b.expected_return_date';
  }

  query += ' ORDER BY b.return_date DESC, b.borrow_id DESC';

  const result = await request.query(query);
  return result.recordset;
}

async function findByBorrower(borrowerId, openOnly) {
  const pool = await poolPromise;
  const request = pool.request().input('id', sql.Int, borrowerId);

  let query = `
    SELECT ${selectFields()},
           CASE WHEN b.return_date IS NULL THEN 'Out' ELSE 'Returned' END AS loan_status
    FROM dbo.part_borrow_record b
    ${joins()}
    WHERE b.borrower_id = @id
  `;
  if (openOnly === 'true') query += ' AND b.return_date IS NULL';
  query += ' ORDER BY b.borrow_date DESC';

  const result = await request.query(query);
  return result.recordset;
}

// Deleting a loan record is for correcting a mistaken entry, not erasing
// history. If it is still open the quantity has to go back on the shelf,
// otherwise it stays counted as out with nothing holding it.
async function remove(borrowId) {
  const pool = await poolPromise;
  const transaction = new sql.Transaction(pool);
  await transaction.begin();

  try {
    const found = await new sql.Request(transaction)
      .input('id', sql.Int, borrowId)
      .query('SELECT * FROM dbo.part_borrow_record WHERE borrow_id = @id');

    const loan = found.recordset[0];
    if (!loan) {
      await transaction.rollback();
      return null;
    }

    await new sql.Request(transaction)
      .input('id', sql.Int, borrowId)
      .query('DELETE FROM dbo.part_borrow_record WHERE borrow_id = @id');

    if (!loan.return_date) {
      await partStockModel.incrementById(loan.stock_id, loan.quantity, transaction);
    }

    await transaction.commit();
    return loan;
  } catch (err) {
    try { await transaction.rollback(); } catch { /* already rolled back */ }
    throw err;
  }
}

module.exports = {
  AVAILABLE_STATUS,
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
