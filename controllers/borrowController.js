const borrowModel = require('../models/borrowModel');
const employeeModel = require('../models/employeeModel');


const today = () => new Date().toISOString().slice(0, 10);

// SQL Server date columns come back as JS Date objects, which stringify
// into "Tue Jul 28 2026 07:00:00 GMT+0700..." inside template literals.
// Trim to plain YYYY-MM-DD for anything shown to a user.
const asDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

// POST /api/borrow
// Rules enforced here, each with a specific error so the frontend can
// tell the user exactly why a request was refused:
//   1. equipment must exist
//   2. equipment must not belong to anyone (owner = permanent assignment)
//   3. equipment status must be 'Working - IT Stock'
//   4. equipment must not already be out on loan
//   5. borrower must be a real employee
async function borrow(req, res, next) {
  const { equipment_id, borrower_id, full_name, borrow_date } = req.body;

  if (!equipment_id) {
    return res.status(400).json({ error: 'equipment_id is required' });
  }
  if (!borrower_id && !full_name) {
    return res.status(400).json({ error: 'Either borrower_id or full_name is required' });
  }

  try {
    const equipment = await borrowModel.findEquipmentForBorrow(equipment_id);
    if (!equipment) {
      return res.status(404).json({ error: `No equipment found with id ${equipment_id}` });
    }

    if (equipment.owner_id) {
      return res.status(409).json({
        error: `Cannot borrow: this is permanently assigned to ${equipment.current_owner}`,
        current_owner: equipment.current_owner,
        hint: 'Only unassigned stock can be borrowed.',
      });
    }

    if (equipment.open_borrow_id) {
      return res.status(409).json({
        error: `Cannot borrow: already out with ${equipment.current_borrower} since ${asDate(equipment.open_borrow_date)}`,
        current_borrower: equipment.current_borrower,
        borrowed_since: equipment.open_borrow_date,
        open_borrow_id: equipment.open_borrow_id,
      });
    }

    if (!equipment.is_borrowable) {
      return res.status(409).json({
        error: `Cannot borrow: status "${equipment.status}" is not borrowable`,
        current_status: equipment.status,
        hint: 'See GET /api/statuses for which statuses allow borrowing.',
      });
    }

    let resolvedBorrowerId = borrower_id;
    if (!resolvedBorrowerId) {
      const employee = await employeeModel.findByName(full_name);
      if (!employee) {
        return res.status(404).json({ error: `No employee found with name "${full_name}"` });
      }
      resolvedBorrowerId = employee.employee_id;
    }

    const record = await borrowModel.create({
      ...req.body,
      borrower_id: resolvedBorrowerId,
      borrow_date: borrow_date || today(),
    });

    res.status(201).json({
      message: 'Equipment borrowed',
      borrow: record,
      equipment: {
        equipment_id: equipment.equipment_id,
        category_name: equipment.category_name,
        computer_name: equipment.computer_name,
        device_model: equipment.device_model,
        equipment_code: equipment.equipment_code,
      },
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/borrow/:id/return   - return by borrow_id
// POST /api/borrow/return       - return by equipment_id (frontend often
//                                 knows the item, not the loan record)
async function returnItem(req, res, next) {
  const borrowIdParam = req.params.id;
  const { equipment_id, return_date } = req.body;

  if (!borrowIdParam && !equipment_id) {
    return res.status(400).json({ error: 'Provide a borrow id in the URL, or equipment_id in the body' });
  }

  try {
    let loan;
    if (borrowIdParam) {
      loan = await borrowModel.findById(borrowIdParam);
      if (!loan) {
        return res.status(404).json({ error: `No borrow record found with id ${borrowIdParam}` });
      }
      if (loan.return_date) {
        return res.status(409).json({
          error: `This was already returned on ${asDate(loan.return_date)}`,
          returned_on: loan.return_date,
        });
      }
    } else {
      loan = await borrowModel.findOpenLoanByEquipment(equipment_id);
      if (!loan) {
        return res.status(404).json({
          error: `Equipment ${equipment_id} is not currently out on loan`,
        });
      }
    }

    // return_status lets an item come back as 'Broken - IT Stock' rather than
    // going straight back into the borrowable pool.
    const updated = await borrowModel.markReturned(loan.borrow_id, {
      ...req.body,
      return_date: return_date || today(),
    });

    res.json({ message: 'Equipment returned', borrow: updated });
  } catch (err) {
    next(err);
  }
}

async function getCurrent(req, res, next) {
  try {
    const records = await borrowModel.findCurrentlyBorrowed(req.query.overdue);
    res.json({
      count: records.length,
      overdue_count: records.filter(r => r.is_overdue).length,
      borrowed: records,
    });
  } catch (err) {
    next(err);
  }
}

async function getHistory(req, res, next) {
  try {
    const records = await borrowModel.findHistory(req.query);
    res.json({ count: records.length, history: records });
  } catch (err) {
    next(err);
  }
}

// The Returns page: what has come back, when, and in what condition.
async function getReturns(req, res, next) {
  try {
    const records = await borrowModel.findReturns(req.query);
    res.json({
      count: records.length,
      late_count: records.filter(r => r.was_late === 1).length,
      returns: records,
    });
  } catch (err) {
    next(err);
  }
}

async function getAvailable(req, res, next) {
  try {
    const equipment = await borrowModel.findAvailableToBorrow(req.query.category);
    res.json({ count: equipment.length, equipment });
  } catch (err) {
    next(err);
  }
}


async function getById(req, res, next) {
  try {
    const record = await borrowModel.findById(req.params.id);
    if (!record) return res.status(404).json({ error: 'Borrow record not found' });
    res.json(record);
  } catch (err) {
    next(err);
  }
}

async function getByBorrower(req, res, next) {
  try {
    const records = await borrowModel.findByBorrower(req.params.id, req.query.open);
    res.json({ count: records.length, records });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  borrow, returnItem, getCurrent, getHistory, getReturns,
  getAvailable, getById, getByBorrower,
};
