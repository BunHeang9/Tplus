const partBorrowModel = require('../models/partBorrowModel');
const partStockModel = require('../models/partStockModel');

// Temporary loans of individual parts out of stock - RAM, CPU, Bag, Mouse...
// Separate from /api/borrow, which loans a whole piece of equipment (always
// qty 1, tracked by flipping its status). A part_stock line has a quantity
// instead of a status to flip, so borrowing here takes some of that quantity
// off the shelf and a return puts it back, rather than marking the line
// itself "Borrowed".

const today = () => new Date().toISOString().slice(0, 10);
const asDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

// POST /api/part-borrow
// { stock_id, quantity, borrower_id, borrow_date, expected_return_date,
//   condition_on_borrow, purpose, remark }
async function borrow(req, res, next) {
  const { stock_id, quantity, borrower_id, borrow_date } = req.body;

  if (!stock_id) {
    return res.status(400).json({ error: 'stock_id is required' });
  }
  if (!borrower_id) {
    return res.status(400).json({ error: 'borrower_id is required' });
  }
  if (!quantity || quantity < 1) {
    return res.status(400).json({
      error: 'quantity is required and must be at least 1',
      example: { stock_id, quantity: 1, borrower_id, condition_on_borrow: 'Working' },
    });
  }

  try {
    const stock = await partBorrowModel.findStockForBorrow(stock_id);
    if (!stock) {
      return res.status(404).json({ error: `No stock line found with id ${stock_id}` });
    }
    if (stock.status !== partBorrowModel.AVAILABLE_STATUS) {
      return res.status(409).json({
        error: `Cannot borrow: this line's status is "${stock.status}", not "${partBorrowModel.AVAILABLE_STATUS}"`,
        current_status: stock.status,
      });
    }
    if (quantity > stock.quantity) {
      return res.status(409).json({
        error: `Only ${stock.quantity} of ${stock.part_name} ${stock.part_value || stock.model_name || ''} available, cannot borrow ${quantity}`,
        available: stock.quantity,
      });
    }

    const record = await partBorrowModel.create({
      ...req.body,
      borrow_date: borrow_date || today(),
      // The lender is whoever is logged in, not a field the frontend fills
      // in - admin accounts (Tplus Admin, John Sey) live in api_user, not
      // the employee table, so there is no list to pick one from anyway.
      issued_by_id: req.user.user_id,
    });
    if (record.error === 'insufficient_stock') {
      return res.status(409).json({
        error: `Only ${stock.quantity} of ${stock.part_name} available, cannot borrow ${quantity}`,
        available: stock.quantity,
      });
    }

    res.status(201).json({
      message: `${quantity} x ${stock.part_name} borrowed`,
      borrow: record,
      part: {
        stock_id: stock.stock_id,
        part_name: stock.part_name,
        part_value: stock.part_value,
        model_name: stock.model_name,
      },
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/part-borrow/:id/return
// { return_date, condition_on_return, return_status, received_by_id, remark }
async function returnItem(req, res, next) {
  const { return_date } = req.body;

  try {
    const loan = await partBorrowModel.findById(req.params.id);
    if (!loan) {
      return res.status(404).json({ error: `No borrow record found with id ${req.params.id}` });
    }
    if (loan.return_date) {
      return res.status(409).json({
        error: `This was already returned on ${asDate(loan.return_date)}`,
        returned_on: loan.return_date,
      });
    }
    if (req.body.return_status && !partStockModel.STATUSES.includes(req.body.return_status)) {
      return res.status(400).json({
        error: `return_status must be one of: ${partStockModel.STATUSES.join(', ')}`,
      });
    }

    const updated = await partBorrowModel.markReturned(req.params.id, {
      ...req.body,
      return_date: return_date || today(),
      received_by_id: req.user.user_id,
    });

    res.json({ message: 'Part returned', borrow: updated });
  } catch (err) {
    next(err);
  }
}

// GET /api/part-borrow/current?overdue=true
async function getCurrent(req, res, next) {
  try {
    const records = await partBorrowModel.findCurrentlyBorrowed(req.query.overdue);
    res.json({
      count: records.length,
      overdue_count: records.filter((r) => r.is_overdue === 1).length,
      borrowed: records,
    });
  } catch (err) {
    next(err);
  }
}

// GET /api/part-borrow/history?stock_id=&borrower_id=&from=&to=
async function getHistory(req, res, next) {
  try {
    const records = await partBorrowModel.findHistory(req.query);
    res.json({ count: records.length, history: records });
  } catch (err) {
    next(err);
  }
}

// GET /api/part-borrow/returns
async function getReturns(req, res, next) {
  try {
    const records = await partBorrowModel.findReturns(req.query);
    res.json({
      count: records.length,
      late_count: records.filter((r) => r.was_late === 1).length,
      returns: records,
    });
  } catch (err) {
    next(err);
  }
}

// GET /api/part-borrow/available?part_type_id=
// What can be borrowed right now - same shelf partStockModel.findAvailable
// already serves for fitting, since the rule ("Working - IT Stock", qty > 0)
// is identical either way.
async function getAvailable(req, res, next) {
  try {
    const stock = await partStockModel.findAvailable(req.query.part_type_id);
    res.json({ count: stock.length, stock });
  } catch (err) {
    next(err);
  }
}

async function getById(req, res, next) {
  try {
    const record = await partBorrowModel.findById(req.params.id);
    if (!record) return res.status(404).json({ error: 'Borrow record not found' });
    res.json(record);
  } catch (err) {
    next(err);
  }
}

async function getByBorrower(req, res, next) {
  try {
    const records = await partBorrowModel.findByBorrower(req.params.id, req.query.open);
    res.json({ count: records.length, records });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/part-borrow/:id  (admin)
// Corrects a mistaken entry rather than erasing history - if the loan is
// still open, its quantity goes back on the shelf first.
async function remove(req, res, next) {
  try {
    const removed = await partBorrowModel.remove(req.params.id);
    if (!removed) return res.status(404).json({ error: 'Borrow record not found' });
    res.json({ message: 'Borrow record removed', removed });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  borrow, returnItem, getCurrent, getHistory, getReturns,
  getAvailable, getById, getByBorrower, remove,
};
