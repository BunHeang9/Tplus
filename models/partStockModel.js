const { sql, poolPromise } = require('../config/db');

// Spare parts held in stock.
//
// Counted rather than identified: stock says "3 x 8GB RAM working" instead of
// tracking each module with its own code. Labelling every stick is work nobody
// would keep up with, and a stock list that drifts is worse than none.
//
// Working and broken are separate lines of the same part, so a faulty module
// is never offered for fitting.

// The only two states a spare part can be in on the shelf. Equipment has more
// (Installed, Borrowed, Working/Using...) because a device is in active
// service; a loose part sitting in a box either still works or it doesn't.
const STATUSES = ['Working - IT Stock', 'Broken - IT Stock'];

// "16", "16GB", "16gb", " 16 GB " all become "16 GB" - so the same real
// value never fragments into different stock lines just because of how it
// was typed in. Only a bare number or a GB-suffixed one is touched; a
// different unit (MB, TB) or a non-numeric value (a CPU model, say) is left
// exactly as entered, since guessing at a unit conversion risks silently
// corrupting the real value.
function normalizePartValue(value) {
  if (value === null || value === undefined) return value;
  const str = String(value).trim();
  const match = str.match(/^(\d+(?:\.\d+)?)\s*(GB)?$/i);
  return match ? `${match[1]} GB` : str;
}

// Reads the leading number out of a stock value regardless of a "GB" suffix,
// so RAM-add math ("8" + "8" = "16") keeps working whether the caller typed
// "8" or "8 GB" - the canonical stock format changed, the arithmetic should
// not care.
function parseNumericPartValue(value) {
  if (value === null || value === undefined) return NaN;
  const match = String(value).trim().match(/^(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : NaN;
}

async function findAll(filters = {}) {
  const { part_type_id, status, in_stock_only } = filters;
  const pool = await poolPromise;
  const request = pool.request();

  let query = `
    SELECT s.stock_id, s.part_type_id, pt.part_name, pt.is_countable,
           pt.tracks_value,
           s.part_value, s.model_name, s.model_number,
           s.disk_type, s.disk_interface, s.ram_type,
           s.status, s.quantity, s.location, s.remark, s.is_active, s.updated_at,
           -- Separate from status: status is the part's condition (working/
           -- broken), this is whether there's any left to hand out. A broken
           -- line at 0 is still "Broken", just also out of stock.
           CASE WHEN s.quantity = 0 THEN 'Out of Stock' ELSE 'In Stock' END AS stock_state
    FROM dbo.part_stock s
    JOIN dbo.part_type pt ON s.part_type_id = pt.part_type_id
    WHERE 1=1
  `;

  if (part_type_id) {
    query += ' AND s.part_type_id = @part_type_id';
    request.input('part_type_id', sql.Int, part_type_id);
  }
  if (status) {
    query += ' AND s.status = @status';
    request.input('status', sql.VarChar, status);
  }
  // A line that has dropped to zero is history, not stock - the form should
  // not offer it.
  if (in_stock_only === 'true') query += ' AND s.quantity > 0';
  query += ' AND s.is_active = 1';
  // Falls back to the model name - accessories have no part_value, so
  // ordering on it alone would group them unpredictably.
  query += ' ORDER BY pt.sort_order, COALESCE(s.part_value, s.model_name), s.status';

  const result = await request.query(query);
  return result.recordset;
}

// What can actually be fitted right now: working, and more than zero.
async function findAvailable(partTypeId) {
  const pool = await poolPromise;
  const request = pool.request();

  let query = `
    SELECT s.stock_id, s.part_type_id, pt.part_name, pt.tracks_value,
           s.part_value, s.model_name, s.model_number,
           s.disk_type, s.disk_interface, s.ram_type,
           s.status, s.quantity, s.location
    FROM dbo.part_stock s
    JOIN dbo.part_type pt ON s.part_type_id = pt.part_type_id
    WHERE s.quantity > 0
      AND s.is_active = 1
            -- Only stock statuses can be fitted. Excluding known-bad ones let
      -- 'Borrowed' and 'Working/Using' through, neither of which describes
      -- something sitting on a shelf.
      AND s.status = 'Working - IT Stock'
  `;
  if (partTypeId) {
    query += ' AND s.part_type_id = @part_type_id';
    request.input('part_type_id', sql.Int, partTypeId);
  }
  query += ' ORDER BY pt.sort_order, COALESCE(s.part_value, s.model_name)';

  const result = await request.query(query);
  return result.recordset;
}

async function findById(stockId) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('id', sql.Int, stockId)
    .query(`
      SELECT s.*, pt.part_name, pt.is_countable
      FROM dbo.part_stock s
      JOIN dbo.part_type pt ON s.part_type_id = pt.part_type_id
      WHERE s.stock_id = @id
    `);
  return result.recordset[0] || null;
}

// Adds to stock, creating the line if this part, value and condition have not
// been seen before. MERGE rather than insert-or-update in code, so two
// simultaneous returns cannot both decide the row is missing.
async function increment(partTypeId, partValue, status, qty, transaction, extra = {}) {
  const pool = await poolPromise;
  const request = transaction ? new sql.Request(transaction) : pool.request();

  const result = await request
    .input('part_type_id', sql.Int, partTypeId)
    .input('part_value', sql.NVarChar, normalizePartValue(partValue) || null)
    .input('model_name', sql.NVarChar, extra.model_name || null)
    .input('model_number', sql.NVarChar, extra.model_number || null)
    .input('disk_type', sql.VarChar, extra.disk_type || null)
    .input('disk_interface', sql.VarChar, extra.disk_interface || null)
    .input('ram_type', sql.VarChar, extra.ram_type || null)
    .input('status', sql.VarChar, status || 'Working - IT Stock')
    .input('qty', sql.Int, qty ?? 1)
    .input('location', sql.VarChar, extra.location || null)
    .input('remark', sql.NVarChar, extra.remark || null)
    .query(`
      MERGE dbo.part_stock AS target
      USING (SELECT @part_type_id AS part_type_id) AS source
      ON target.part_type_id = source.part_type_id
         AND ISNULL(target.part_value, '')   = ISNULL(@part_value, '')
         AND ISNULL(target.model_name, '')   = ISNULL(@model_name, '')
         AND ISNULL(target.model_number, '') = ISNULL(@model_number, '')
         AND ISNULL(target.disk_type, '')      = ISNULL(@disk_type, '')
         AND ISNULL(target.disk_interface, '') = ISNULL(@disk_interface, '')
        AND ISNULL(target.ram_type, '')       = ISNULL(@ram_type, '')
         AND target.status = @status
      WHEN MATCHED THEN
        UPDATE SET quantity = target.quantity + @qty,
                   updated_at = GETDATE(),
                   location = COALESCE(@location, target.location)
      WHEN NOT MATCHED THEN
        INSERT (part_type_id, part_value, model_name, model_number,
                disk_type, disk_interface, ram_type,
                status, quantity, location, remark)
        VALUES (@part_type_id, @part_value, @model_name, @model_number,
                @disk_type, @disk_interface, @ram_type,
                @status, @qty, @location, @remark)
      OUTPUT INSERTED.*;
    `);
  return result.recordset[0];
}

// Takes from stock. Returns null when the line does not exist or is short,
// rather than letting the quantity go negative - the caller turns that into a
// clear message.
async function decrement(stockId, qty, transaction) {
  const pool = await poolPromise;
  const request = transaction ? new sql.Request(transaction) : pool.request();

  const result = await request
    .input('id', sql.Int, stockId)
    .input('qty', sql.Int, qty ?? 1)
    .query(`
      UPDATE dbo.part_stock
      SET quantity = quantity - @qty, updated_at = GETDATE()
      OUTPUT INSERTED.*
      WHERE stock_id = @id AND quantity >= @qty
    `);
  return result.recordset[0] || null;
}

// Puts quantity back on a specific line by id - a return, where the part is
// going back to exactly where it came from rather than being matched by
// attributes the way increment() does for newly bought-in stock.
async function incrementById(stockId, qty, transaction) {
  const pool = await poolPromise;
  const request = transaction ? new sql.Request(transaction) : pool.request();

  const result = await request
    .input('id', sql.Int, stockId)
    .input('qty', sql.Int, qty ?? 1)
    .query(`
      UPDATE dbo.part_stock
      SET quantity = quantity + @qty, updated_at = GETDATE()
      OUTPUT INSERTED.*
      WHERE stock_id = @id
    `);
  return result.recordset[0] || null;
}

// Manual correction - a stock take, or parts bought in.
async function setQuantity(stockId, quantity) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('id', sql.Int, stockId)
    .input('quantity', sql.Int, quantity)
    .query(`
      UPDATE dbo.part_stock
      SET quantity = @quantity, updated_at = GETDATE()
      OUTPUT INSERTED.*
      WHERE stock_id = @id
    `);
  return result.recordset[0] || null;
}
// Edits a line: quantity, model details, status, remark or the active flag.
//
// Editing identifying fields (value, model, type, status) can turn a line
// into an exact match of a different line that already exists - e.g.
// correcting this one's ram_type to DDR5 when a "16GB DDR5 Working" line is
// already on the shelf. uq_part_stock_line rejects that as a duplicate key,
// so rather than let the raw SQL error surface, the edit is merged into the
// matching line instead: its quantity moves over and this row is removed.
// Same behaviour increment() already uses when adding stock.
async function updateLine(stockId, d) {
  const pool = await poolPromise;
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  const normalizedPartValue = d.part_value === undefined ? undefined : normalizePartValue(d.part_value);

  try {
    const current = await new sql.Request(transaction)
      .input('id', sql.Int, stockId)
      .query('SELECT * FROM dbo.part_stock WHERE stock_id = @id');
    const existing = current.recordset[0];
    if (!existing) {
      await transaction.rollback();
      return null;
    }

    const resulting = {
      part_value: normalizedPartValue ?? existing.part_value,
      model_name: d.model_name ?? existing.model_name,
      model_number: d.model_number ?? existing.model_number,
      disk_type: d.disk_type ?? existing.disk_type,
      disk_interface: d.disk_interface ?? existing.disk_interface,
      ram_type: d.ram_type ?? existing.ram_type,
      status: d.status ?? existing.status,
    };

    const clash = await new sql.Request(transaction)
      .input('id', sql.Int, stockId)
      .input('part_type_id', sql.Int, existing.part_type_id)
      .input('part_value', sql.NVarChar, resulting.part_value)
      .input('model_name', sql.NVarChar, resulting.model_name)
      .input('model_number', sql.NVarChar, resulting.model_number)
      .input('disk_type', sql.VarChar, resulting.disk_type)
      .input('disk_interface', sql.VarChar, resulting.disk_interface)
      .input('ram_type', sql.VarChar, resulting.ram_type)
      .input('status', sql.VarChar, resulting.status)
      .query(`
        SELECT TOP 1 stock_id FROM dbo.part_stock
        WHERE stock_id <> @id
          AND part_type_id = @part_type_id
          AND ISNULL(part_value, '') = ISNULL(@part_value, '')
          AND ISNULL(model_name, '') = ISNULL(@model_name, '')
          AND ISNULL(model_number, '') = ISNULL(@model_number, '')
          AND ISNULL(disk_type, '') = ISNULL(@disk_type, '')
          AND ISNULL(disk_interface, '') = ISNULL(@disk_interface, '')
          AND ISNULL(ram_type, '') = ISNULL(@ram_type, '')
          AND status = @status
      `);
    const clashRow = clash.recordset[0];

    let result;
    if (clashRow) {
      const merged = await new sql.Request(transaction)
        .input('id', sql.Int, clashRow.stock_id)
        .input('qty', sql.Int, existing.quantity)
        .query(`
          UPDATE dbo.part_stock
          SET quantity = quantity + @qty, updated_at = GETDATE()
          OUTPUT INSERTED.*
          WHERE stock_id = @id
        `);
      await new sql.Request(transaction)
        .input('id', sql.Int, stockId)
        .query('DELETE FROM dbo.part_stock WHERE stock_id = @id');
      result = { ...merged.recordset[0], merged_from: stockId };
    } else {
      const updated = await new sql.Request(transaction)
        .input('id', sql.Int, stockId)
        .input('quantity', sql.Int, d.quantity)
        .input('model_name', sql.NVarChar, d.model_name)
        .input('model_number', sql.NVarChar, d.model_number)
        .input('part_value', sql.NVarChar, normalizedPartValue)
        .input('disk_type', sql.VarChar, d.disk_type)
        .input('disk_interface', sql.VarChar, d.disk_interface)
        .input('ram_type', sql.VarChar, d.ram_type)
        .input('status', sql.VarChar, d.status)
        .input('location', sql.VarChar, d.location)
        .input('remark', sql.NVarChar, d.remark)
        .input('is_active', sql.Bit, d.is_active === undefined ? null : (d.is_active ? 1 : 0))
        .query(`
          UPDATE dbo.part_stock
          SET quantity     = COALESCE(@quantity, quantity),
              part_value   = COALESCE(@part_value, part_value),
              model_name   = COALESCE(@model_name, model_name),
              model_number = COALESCE(@model_number, model_number),
              disk_type      = COALESCE(@disk_type, disk_type),
              disk_interface = COALESCE(@disk_interface, disk_interface),
              ram_type       = COALESCE(@ram_type, ram_type),
              status       = COALESCE(@status, status),
              location     = COALESCE(@location, location),
              remark       = COALESCE(@remark, remark),
              is_active    = COALESCE(@is_active, is_active),
              updated_at   = GETDATE()
          OUTPUT INSERTED.*
          WHERE stock_id = @id
        `);
      result = updated.recordset[0] || null;
    }

    await transaction.commit();
    return result;
  } catch (err) {
    try { await transaction.rollback(); } catch { /* already rolled back */ }
    throw err;
  }
}
// Clears part_stock_custom_value first - it references stock_id with no
// cascade, so leaving it behind blocks the delete with a raw FK error
// instead of succeeding cleanly. Same fix as partModel.removeType() needed
// for part_type_custom_field.
async function remove(stockId) {
  const pool = await poolPromise;
  const transaction = new sql.Transaction(pool);
  await transaction.begin();

  try {
    await new sql.Request(transaction)
      .input('id', sql.Int, stockId)
      .query('DELETE FROM dbo.part_stock_custom_value WHERE stock_id = @id');

    const result = await new sql.Request(transaction)
      .input('id', sql.Int, stockId)
      .query('DELETE FROM dbo.part_stock OUTPUT DELETED.* WHERE stock_id = @id');

    await transaction.commit();
    return result.recordset[0] || null;
  } catch (err) {
    try { await transaction.rollback(); } catch { /* already rolled back */ }
    throw err;
  }
}

// Totals for a dashboard tile.
async function getSummary() {
  const pool = await poolPromise;
  const result = await pool.request().query(`
    SELECT pt.part_name,
           SUM(CASE WHEN s.status NOT LIKE '%Broken%' AND s.status NOT LIKE '%Retired%'
                    THEN s.quantity ELSE 0 END) AS working,
           SUM(CASE WHEN s.status LIKE '%Broken%' THEN s.quantity ELSE 0 END) AS broken,
           SUM(s.quantity) AS total
    FROM dbo.part_stock s
    JOIN dbo.part_type pt ON s.part_type_id = pt.part_type_id
    GROUP BY pt.part_name, pt.sort_order
    ORDER BY pt.sort_order
  `);
  return result.recordset;
}

module.exports = {
  STATUSES,
  parseNumericPartValue,
  findAll, findAvailable, findById,
  increment, decrement, incrementById, setQuantity, updateLine, remove, getSummary,
};