const sequelize = require('../config/sequelize');
const { QueryTypes } = require('sequelize');

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

// Raw queries with no model attribute definition return a plain string for a
// DATE/DATETIME column; the driver this replaces returned a Date object for
// the same column. Converting back keeps every response identical to before
// this migration.
const DATE_FIELDS = ['borrow_date', 'expected_return_date', 'return_date', 'created_at'];
function fixDates(row) {
  if (!row) return row;
  for (const f of DATE_FIELDS) {
    if (row[f]) row[f] = new Date(row[f]);
  }
  return row;
}

// Everything needed to decide whether this item can be lent out.
async function findEquipmentForBorrow(equipmentId) {
  const rows = await sequelize.query(`
      SELECT e.equipment_id, e.owner_id, e.status,
             st.is_borrowable,
             e.computer_name, e.device_model, e.asset_code,
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
      WHERE e.equipment_id = :id
    `, { replacements: { id: equipmentId }, type: QueryTypes.SELECT });
  const row = rows[0];
  if (row && row.open_borrow_date) row.open_borrow_date = new Date(row.open_borrow_date);
  return row || null;
}

// Creating the loan and flipping the equipment status happen together in a
// transaction. If either fails, neither is applied - so we never end up with
// a loan whose equipment still looks available, or vice versa. Self-contained
// (no external transaction interop), so this uses sequelize.transaction().
async function create(d) {
  return sequelize.transaction(async (transaction) => {
    const [inserted] = await sequelize.query(`
        INSERT INTO dbo.borrow_record (
          equipment_id, borrower_id, borrow_date, expected_return_date,
          condition_on_borrow, issued_by_id, purpose, remark
        )
        OUTPUT INSERTED.*
        VALUES (
          :equipment_id, :borrower_id, :borrow_date, :expected_return_date,
          :condition_on_borrow, :issued_by_id, :purpose, :remark
        )
      `, {
      replacements: {
        equipment_id: d.equipment_id,
        borrower_id: d.borrower_id,
        borrow_date: d.borrow_date,
        expected_return_date: d.expected_return_date || null,
        condition_on_borrow: d.condition_on_borrow || null,
        issued_by_id: d.issued_by_id || null,
        purpose: d.purpose || null,
        remark: d.remark || null,
      },
      type: QueryTypes.SELECT,
      transaction,
    });

    await sequelize.query(`
        UPDATE dbo.equipment
        SET status    = :status,
            status_id = (SELECT status_id FROM dbo.equipment_status WHERE status_name = :status)
        WHERE equipment_id = :equipment_id
      `, {
      replacements: { equipment_id: d.equipment_id, status: BORROWED_STATUS },
      transaction,
    });

    return fixDates(inserted);
  });
}

async function findById(borrowId) {
  const rows = await sequelize.query(`
      SELECT b.*,
             e.computer_name, e.device_model, e.asset_code,
             c.category_name,
             emp.full_name AS borrower_name
      FROM dbo.borrow_record b
      JOIN dbo.equipment e     ON b.equipment_id = e.equipment_id
      JOIN dbo.employee emp    ON b.borrower_id = emp.employee_id
      LEFT JOIN dbo.category c ON e.category_id = c.category_id
      WHERE b.borrow_id = :id
    `, { replacements: { id: borrowId }, type: QueryTypes.SELECT });
  return fixDates(rows[0]) || null;
}

// Lets the caller return an item by equipment_id without knowing the borrow_id.
async function findOpenLoanByEquipment(equipmentId) {
  const rows = await sequelize.query(`
      SELECT TOP 1 * FROM dbo.borrow_record
      WHERE equipment_id = :id AND return_date IS NULL
      ORDER BY borrow_date DESC
    `, { replacements: { id: equipmentId }, type: QueryTypes.SELECT });
  return fixDates(rows[0]) || null;
}

// Closing the loan and returning the equipment to stock, in one transaction.
// If the item came back faulty the caller can pass return_status, e.g.
// 'Broken - IT Stock', instead of it going straight back into circulation.
// Self-contained, so this uses sequelize.transaction().
async function markReturned(borrowId, d) {
  return sequelize.transaction(async (transaction) => {
    const [returned] = await sequelize.query(`
        UPDATE dbo.borrow_record
        SET return_date         = :return_date,
            condition_on_return = :condition_on_return,
            received_by_id      = COALESCE(:received_by_id, received_by_id),
            remark              = COALESCE(:remark, remark)
        OUTPUT INSERTED.*
        WHERE borrow_id = :id
      `, {
      replacements: {
        id: borrowId,
        return_date: d.return_date,
        condition_on_return: d.condition_on_return || null,
        received_by_id: d.received_by_id || null,
        remark: d.remark || null,
      },
      type: QueryTypes.SELECT,
      transaction,
    });

    if (returned) {
      await sequelize.query(`
          UPDATE dbo.equipment
          SET status    = :status,
              status_id = (SELECT status_id FROM dbo.equipment_status WHERE status_name = :status)
          WHERE equipment_id = :equipment_id
        `, {
        replacements: { equipment_id: returned.equipment_id, status: d.return_status || BORROWABLE_STATUS },
        transaction,
      });
    }

    return fixDates(returned) || null;
  });
}

async function findCurrentlyBorrowed(overdueOnly) {
  let query = 'SELECT * FROM dbo.vw_currently_borrowed';
  if (overdueOnly === 'true') query += ' WHERE is_overdue = 1';
  query += ' ORDER BY is_overdue DESC, borrow_date';
  const rows = await sequelize.query(query, { type: QueryTypes.SELECT });
  return rows.map(fixDates);
}

async function findHistory(filters = {}) {
  const { equipment_id, borrower_id, from, to } = filters;

  let query = `
    SELECT b.borrow_id, b.equipment_id,
           c.category_name, e.computer_name, e.device_model, e.asset_code,
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
  const replacements = {};

  if (equipment_id) {
    query += ' AND b.equipment_id = :equipment_id';
    replacements.equipment_id = equipment_id;
  }
  if (borrower_id) {
    query += ' AND b.borrower_id = :borrower_id';
    replacements.borrower_id = borrower_id;
  }
  if (from) {
    query += ' AND b.borrow_date >= :from';
    replacements.from = from;
  }
  if (to) {
    query += ' AND b.borrow_date <= :to';
    replacements.to = to;
  }

  query += ' ORDER BY b.borrow_date DESC, b.borrow_id DESC';

  const rows = await sequelize.query(query, { replacements, type: QueryTypes.SELECT });
  return rows.map(fixDates);
}

// Returned loans only - the Returns page. Newest first, and it works out
// days_kept and was_late here rather than making the frontend calculate them.
async function findReturns(filters = {}) {
  const { equipment_id, borrower_id, from, to, late_only } = filters;

  let query = `
    SELECT b.borrow_id,
           b.equipment_id,
           c.category_name,
           e.computer_name,
           e.device_model,
           e.asset_code,
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
  const replacements = {};

  if (equipment_id) {
    query += ' AND b.equipment_id = :equipment_id';
    replacements.equipment_id = equipment_id;
  }
  if (borrower_id) {
    query += ' AND b.borrower_id = :borrower_id';
    replacements.borrower_id = borrower_id;
  }
  if (from) {
    query += ' AND b.return_date >= :from';
    replacements.from = from;
  }
  if (to) {
    query += ' AND b.return_date <= :to';
    replacements.to = to;
  }
  if (late_only === 'true') {
    query += ' AND b.expected_return_date IS NOT NULL AND b.return_date > b.expected_return_date';
  }

  query += ' ORDER BY b.return_date DESC, b.borrow_id DESC';

  const rows = await sequelize.query(query, { replacements, type: QueryTypes.SELECT });
  return rows.map(fixDates);
}

// What can be borrowed right now: correct status, and not already out.
async function findAvailableToBorrow(category) {
  // Uses the is_borrowable flag on dbo.equipment_status, so the rule lives
  // in one place and can be changed without touching code.
  let query = `
    SELECT e.equipment_id, e.category_id, c.category_name,
           e.device_type, e.computer_name, e.device_model, e.manufacturer,
           e.asset_code, e.service_tag, e.location, e.status
    FROM dbo.equipment e
    LEFT JOIN dbo.category c ON e.category_id = c.category_id
    JOIN dbo.equipment_status st ON e.status_id = st.status_id
    WHERE st.is_borrowable = 1
      AND NOT EXISTS (
          SELECT 1 FROM dbo.borrow_record b
          WHERE b.equipment_id = e.equipment_id AND b.return_date IS NULL
      )
  `;
  const replacements = {};

  if (category) {
    query += ' AND c.category_name = :category';
    replacements.category = category;
  }

  query += ' ORDER BY c.category_name, e.equipment_id';

  return sequelize.query(query, { replacements, type: QueryTypes.SELECT });
}

async function findByBorrower(borrowerId, openOnly) {
  let query = `
    SELECT b.borrow_id, b.equipment_id,
           c.category_name, e.computer_name, e.device_model, e.asset_code,
           b.borrow_date, b.expected_return_date, b.return_date,
           CASE WHEN b.return_date IS NULL THEN 'Out' ELSE 'Returned' END AS loan_status,
           b.condition_on_borrow, b.condition_on_return, b.purpose, b.remark
    FROM dbo.borrow_record b
    JOIN dbo.equipment e     ON b.equipment_id = e.equipment_id
    LEFT JOIN dbo.category c ON e.category_id = c.category_id
    WHERE b.borrower_id = :id
  `;
  if (openOnly === 'true') query += ' AND b.return_date IS NULL';
  query += ' ORDER BY b.borrow_date DESC';

  const rows = await sequelize.query(query, { replacements: { id: borrowerId }, type: QueryTypes.SELECT });
  return rows.map(fixDates);
}

// Deleting a loan record is for correcting a mistaken entry, not for erasing
// history. If the loan is still open the equipment status has to be put back,
// otherwise the item would stay marked Borrowed with nothing holding it.
// Self-contained transaction, so this uses sequelize.transaction().
async function remove(borrowId) {
  return sequelize.transaction(async (transaction) => {
    const [loan] = await sequelize.query(
      'SELECT * FROM dbo.borrow_record WHERE borrow_id = :id',
      { replacements: { id: borrowId }, type: QueryTypes.SELECT, transaction },
    );
    if (!loan) return null;

    await sequelize.query(
      'DELETE FROM dbo.borrow_record WHERE borrow_id = :id',
      { replacements: { id: borrowId }, transaction },
    );

    if (!loan.return_date) {
      await sequelize.query(`
          UPDATE dbo.equipment
          SET status    = :status,
              status_id = (SELECT status_id FROM dbo.equipment_status WHERE status_name = :status)
          WHERE equipment_id = :equipment_id
        `, {
        replacements: { equipment_id: loan.equipment_id, status: BORROWABLE_STATUS },
        transaction,
      });
    }

    return fixDates(loan);
  });
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
