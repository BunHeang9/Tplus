const { sql, poolPromise } = require('../config/db');

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

// Everything needed to decide whether this item can be lent out.
async function findEquipmentForBorrow(equipmentId) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('id', sql.Int, equipmentId)
    .query(`
      SELECT e.equipment_id, e.owner_id, e.status,
             st.is_borrowable,
             e.computer_name, e.device_model, e.equipment_code,
             c.category_name,
             owner.full_name    AS current_owner,
             open_loan.borrow_id   AS open_borrow_id,
             open_loan.borrow_date AS open_borrow_date,
             borrower.full_name AS current_borrower
      FROM dbo.equipment e
      LEFT JOIN dbo.category c    ON e.category_id = c.category_id
      LEFT JOIN dbo.equipment_status st ON e.status_id = st.status_id
      LEFT JOIN dbo.employee owner ON e.owner_id = owner.employee_id
      OUTER APPLY (
          SELECT TOP 1 b.borrow_id, b.borrow_date, b.borrower_id
          FROM dbo.borrow_record b
          WHERE b.equipment_id = e.equipment_id AND b.return_date IS NULL
          ORDER BY b.borrow_date DESC
      ) AS open_loan
      LEFT JOIN dbo.employee borrower ON open_loan.borrower_id = borrower.employee_id
      WHERE e.equipment_id = @id
    `);
  return result.recordset[0] || null;
}

// Creating the loan and flipping the equipment status happen together in a
// transaction. If either fails, neither is applied - so we never end up with
// a loan whose equipment still looks available, or vice versa.
async function create(d) {
  const pool = await poolPromise;
  const transaction = new sql.Transaction(pool);
  await transaction.begin();

  try {
    const insert = await new sql.Request(transaction)
      .input('equipment_id', sql.Int, d.equipment_id)
      .input('borrower_id', sql.Int, d.borrower_id)
      .input('borrow_date', sql.Date, d.borrow_date)
      .input('expected_return_date', sql.Date, d.expected_return_date || null)
      .input('condition_on_borrow', sql.NVarChar, d.condition_on_borrow || null)
      .input('issued_by_id', sql.Int, d.issued_by_id || null)
      .input('purpose', sql.NVarChar, d.purpose || null)
      .input('remark', sql.NVarChar, d.remark || null)
      .query(`
        INSERT INTO dbo.borrow_record (
          equipment_id, borrower_id, borrow_date, expected_return_date,
          condition_on_borrow, issued_by_id, purpose, remark
        )
        OUTPUT INSERTED.*
        VALUES (
          @equipment_id, @borrower_id, @borrow_date, @expected_return_date,
          @condition_on_borrow, @issued_by_id, @purpose, @remark
        )
      `);

    await new sql.Request(transaction)
      .input('equipment_id', sql.Int, d.equipment_id)
      .input('status', sql.VarChar, BORROWED_STATUS)
      .query(`
        UPDATE dbo.equipment
        SET status    = @status,
            status_id = (SELECT status_id FROM dbo.equipment_status WHERE status_name = @status)
        WHERE equipment_id = @equipment_id
      `);

    await transaction.commit();
    return insert.recordset[0];
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

async function findById(borrowId) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('id', sql.Int, borrowId)
    .query(`
      SELECT b.*,
             e.computer_name, e.device_model, e.equipment_code,
             c.category_name,
             emp.full_name AS borrower_name
      FROM dbo.borrow_record b
      JOIN dbo.equipment e     ON b.equipment_id = e.equipment_id
      JOIN dbo.employee emp    ON b.borrower_id = emp.employee_id
      LEFT JOIN dbo.category c ON e.category_id = c.category_id
      WHERE b.borrow_id = @id
    `);
  return result.recordset[0] || null;
}

// Lets the caller return an item by equipment_id without knowing the borrow_id.
async function findOpenLoanByEquipment(equipmentId) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('id', sql.Int, equipmentId)
    .query(`
      SELECT TOP 1 * FROM dbo.borrow_record
      WHERE equipment_id = @id AND return_date IS NULL
      ORDER BY borrow_date DESC
    `);
  return result.recordset[0] || null;
}

// Closing the loan and returning the equipment to stock, in one transaction.
// If the item came back faulty the caller can pass return_status, e.g.
// 'Broken - IT Stock', instead of it going straight back into circulation.
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
        UPDATE dbo.borrow_record
        SET return_date         = @return_date,
            condition_on_return = @condition_on_return,
            received_by_id      = COALESCE(@received_by_id, received_by_id),
            remark              = COALESCE(@remark, remark)
        OUTPUT INSERTED.*
        WHERE borrow_id = @id
      `);

    const returned = update.recordset[0];
    if (returned) {
      await new sql.Request(transaction)
        .input('equipment_id', sql.Int, returned.equipment_id)
        .input('status', sql.VarChar, d.return_status || BORROWABLE_STATUS)
        .query(`
          UPDATE dbo.equipment
          SET status    = @status,
              status_id = (SELECT status_id FROM dbo.equipment_status WHERE status_name = @status)
          WHERE equipment_id = @equipment_id
        `);
    }

    await transaction.commit();
    return returned || null;
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

async function findCurrentlyBorrowed(overdueOnly) {
  const pool = await poolPromise;
  let query = 'SELECT * FROM dbo.vw_currently_borrowed';
  if (overdueOnly === 'true') query += ' WHERE is_overdue = 1';
  query += ' ORDER BY is_overdue DESC, borrow_date';
  const result = await pool.request().query(query);
  return result.recordset;
}

async function findHistory(filters = {}) {
  const { equipment_id, borrower_id, from, to } = filters;
  const pool = await poolPromise;
  const request = pool.request();

  let query = `
    SELECT b.borrow_id, b.equipment_id,
           c.category_name, e.computer_name, e.device_model, e.equipment_code,
           b.borrower_id, emp.full_name AS borrower_name,
           d.department_code AS borrower_department,
           b.borrow_date, b.expected_return_date, b.return_date,
           CASE WHEN b.return_date IS NULL THEN 'Out' ELSE 'Returned' END AS loan_status,
           b.condition_on_borrow, b.condition_on_return,
           issuer.full_name   AS issued_by,
           receiver.full_name AS received_by,
           b.purpose, b.remark
    FROM dbo.borrow_record b
    JOIN dbo.equipment e        ON b.equipment_id = e.equipment_id
    JOIN dbo.employee emp       ON b.borrower_id = emp.employee_id
    LEFT JOIN dbo.category c    ON e.category_id = c.category_id
    LEFT JOIN dbo.department d  ON emp.department_id = d.department_id
    LEFT JOIN dbo.employee issuer   ON b.issued_by_id = issuer.employee_id
    LEFT JOIN dbo.employee receiver ON b.received_by_id = receiver.employee_id
    WHERE 1=1
  `;

  if (equipment_id) {
    query += ' AND b.equipment_id = @equipment_id';
    request.input('equipment_id', sql.Int, equipment_id);
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

// Returned loans only - the Returns page. Newest first, and it works out
// days_kept and was_late here rather than making the frontend calculate them.
async function findReturns(filters = {}) {
  const { equipment_id, borrower_id, from, to, late_only } = filters;
  const pool = await poolPromise;
  const request = pool.request();

  let query = `
    SELECT b.borrow_id,
           b.equipment_id,
           c.category_name,
           e.computer_name,
           e.device_model,
           e.equipment_code,
           e.service_tag,
           b.borrower_id,
           emp.full_name        AS borrower_name,
           emp.position         AS borrower_position,
           d.department_code    AS borrower_department,
           b.borrow_date,
           b.expected_return_date,
           b.return_date,
           DATEDIFF(DAY, b.borrow_date, b.return_date) AS days_kept,
           CASE
               WHEN b.expected_return_date IS NOT NULL
                AND b.return_date > b.expected_return_date
               THEN 1 ELSE 0
           END AS was_late,
           CASE
               WHEN b.expected_return_date IS NOT NULL
                AND b.return_date > b.expected_return_date
               THEN DATEDIFF(DAY, b.expected_return_date, b.return_date)
               ELSE 0
           END AS days_late,
           b.condition_on_borrow,
           b.condition_on_return,
           st.status_name       AS current_status,
           issuer.full_name     AS issued_by,
           receiver.full_name   AS received_by,
           b.purpose,
           b.remark
    FROM dbo.borrow_record b
    JOIN dbo.equipment e             ON b.equipment_id = e.equipment_id
    JOIN dbo.employee emp            ON b.borrower_id = emp.employee_id
    LEFT JOIN dbo.category c         ON e.category_id = c.category_id
    LEFT JOIN dbo.department d       ON emp.department_id = d.department_id
    LEFT JOIN dbo.equipment_status st ON e.status_id = st.status_id
    LEFT JOIN dbo.employee issuer    ON b.issued_by_id = issuer.employee_id
    LEFT JOIN dbo.employee receiver  ON b.received_by_id = receiver.employee_id
    WHERE b.return_date IS NOT NULL
  `;

  if (equipment_id) {
    query += ' AND b.equipment_id = @equipment_id';
    request.input('equipment_id', sql.Int, equipment_id);
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

// What can be borrowed right now: correct status, and not already out.
async function findAvailableToBorrow(category) {
  const pool = await poolPromise;
  const request = pool.request();

  // Uses the is_borrowable flag on dbo.equipment_status, so the rule lives
  // in one place and can be changed without touching code.
  let query = `
    SELECT e.equipment_id, e.category_id, c.category_name,
           e.device_type, e.computer_name, e.device_model, e.manufacturer,
           e.equipment_code, e.service_tag, e.location, e.status
    FROM dbo.equipment e
    LEFT JOIN dbo.category c ON e.category_id = c.category_id
    JOIN dbo.equipment_status st ON e.status_id = st.status_id
    WHERE st.is_borrowable = 1
      AND NOT EXISTS (
          SELECT 1 FROM dbo.borrow_record b
          WHERE b.equipment_id = e.equipment_id AND b.return_date IS NULL
      )
  `;

  if (category) {
    query += ' AND c.category_name = @category';
    request.input('category', sql.VarChar, category);
  }

  query += ' ORDER BY c.category_name, e.equipment_id';

  const result = await request.query(query);
  return result.recordset;
}

async function findByBorrower(borrowerId, openOnly) {
  const pool = await poolPromise;
  const request = pool.request().input('id', sql.Int, borrowerId);

  let query = `
    SELECT b.borrow_id, b.equipment_id,
           c.category_name, e.computer_name, e.device_model, e.equipment_code,
           b.borrow_date, b.expected_return_date, b.return_date,
           CASE WHEN b.return_date IS NULL THEN 'Out' ELSE 'Returned' END AS loan_status,
           b.condition_on_borrow, b.condition_on_return, b.purpose, b.remark
    FROM dbo.borrow_record b
    JOIN dbo.equipment e     ON b.equipment_id = e.equipment_id
    LEFT JOIN dbo.category c ON e.category_id = c.category_id
    WHERE b.borrower_id = @id
  `;
  if (openOnly === 'true') query += ' AND b.return_date IS NULL';
  query += ' ORDER BY b.borrow_date DESC';

  const result = await request.query(query);
  return result.recordset;
}

// Deleting a loan record is for correcting a mistaken entry, not for erasing
// history. If the loan is still open the equipment status has to be put back,
// otherwise the item would stay marked Borrowed with nothing holding it.
async function remove(borrowId) {
  const pool = await poolPromise;
  const transaction = new sql.Transaction(pool);
  await transaction.begin();

  try {
    const found = await new sql.Request(transaction)
      .input('id', sql.Int, borrowId)
      .query('SELECT * FROM dbo.borrow_record WHERE borrow_id = @id');

    const loan = found.recordset[0];
    if (!loan) {
      await transaction.rollback();
      return null;
    }

    await new sql.Request(transaction)
      .input('id', sql.Int, borrowId)
      .query('DELETE FROM dbo.borrow_record WHERE borrow_id = @id');

    if (!loan.return_date) {
      await new sql.Request(transaction)
        .input('equipment_id', sql.Int, loan.equipment_id)
        .input('status', sql.VarChar, BORROWABLE_STATUS)
        .query(`
          UPDATE dbo.equipment
          SET status    = @status,
              status_id = (SELECT status_id FROM dbo.equipment_status WHERE status_name = @status)
          WHERE equipment_id = @equipment_id
        `);
    }

    await transaction.commit();
    return loan;
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

module.exports = {
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
