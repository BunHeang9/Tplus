const { DataTypes, Op, fn } = require('sequelize');
const sequelize = require('../config/sequelize');
const { QueryTypes } = require('sequelize');
const { PartStockStatus } = require('./partStatusModel');

// Leaf models for dbo.part_type and dbo.part_stock - partModel.js only ever
// requires this file lazily (inside functions, to dodge a load-time cycle),
// never the other way round, so it's safe for these two to live here and be
// exported for partModel.js/partBorrowModel.js to build associations onto.
const PartType = sequelize.define('PartType', {
  part_type_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  part_name: { type: DataTypes.STRING(100), allowNull: false },
  description: { type: DataTypes.STRING(510), allowNull: true },
  equipment_column: { type: DataTypes.STRING(50), allowNull: true },
  tracks_value: { type: DataTypes.BOOLEAN, allowNull: true },
  sort_order: { type: DataTypes.INTEGER, allowNull: true },
  is_active: { type: DataTypes.BOOLEAN, allowNull: true },
  // Legacy DATETIME with its own DB-side default - allowNull:true even
  // though the column itself is NOT NULL, same reasoning as
  // partBorrowModel.js's PartBorrowRecord.created_at.
  created_at: { type: DataTypes.DATE, allowNull: true },
  is_countable: { type: DataTypes.BOOLEAN, allowNull: true },
  uses_model: { type: DataTypes.BOOLEAN, allowNull: true },
}, {
  tableName: 'part_type',
  schema: 'dbo',
  timestamps: false,
});

const PartStock = sequelize.define('PartStock', {
  stock_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  part_type_id: { type: DataTypes.INTEGER, allowNull: false },
  part_value: { type: DataTypes.STRING(50), allowNull: true },
  model_name: { type: DataTypes.STRING(100), allowNull: true },
  model_number: { type: DataTypes.STRING(100), allowNull: true },
  disk_type: { type: DataTypes.STRING(30), allowNull: true },
  disk_interface: { type: DataTypes.STRING(30), allowNull: true },
  ram_type: { type: DataTypes.STRING(30), allowNull: true },
  status: { type: DataTypes.STRING(30), allowNull: false },
  quantity: { type: DataTypes.INTEGER, allowNull: false },
  location: { type: DataTypes.STRING(100), allowNull: true },
  remark: { type: DataTypes.STRING(255), allowNull: true },
  is_active: { type: DataTypes.BOOLEAN, allowNull: true },
  // DATETIME, not DATEONLY - fixDates() below still converts it back to a
  // Date object for the functions that stay raw; the two ORM reads
  // (findAll/findAvailable/findById) return it as a string instead, same
  // accepted trade-off as everywhere else in this migration.
  updated_at: { type: DataTypes.DATE, allowNull: true },
}, {
  tableName: 'part_stock',
  schema: 'dbo',
  timestamps: false,
});

PartStock.belongsTo(PartType, { foreignKey: 'part_type_id', as: 'partType' });
// part_stock.status is a foreign key straight to part_stock_status.status_name
// (see partStatusModel.js's own comment for why: no status_id + denormalized
// text pair the way equipment does it, since a rename cascades on its own at
// the database level here). targetKey rather than the default (the target's
// primary key) because the FK points at status_name, not status_id.
PartStock.belongsTo(PartStockStatus, { foreignKey: 'status', targetKey: 'status_name', as: 'statusInfo' });

// Spare parts held in stock.
//
// Counted rather than identified: stock says "3 x 8GB RAM working" instead of
// tracking each module with its own code. Labelling every stick is work nobody
// would keep up with, and a stock list that drifts is worse than none.
//
// Working and broken are separate lines of the same part, so a faulty module
// is never offered for fitting.
//
// The allowed status values themselves now live in dbo.part_stock_status
// (partStatusModel.js), managed like equipment's own statuses - no more
// hardcoded list here.

// Raw queries with no model attribute definition return a plain string for a
// DATETIME column; the driver this replaces returned a Date object for the
// same column. Converting back keeps every response identical to before
// this migration.
function fixDates(row) {
  if (!row) return row;
  if (row.updated_at) row.updated_at = new Date(row.updated_at);
  return row;
}

// `s.*` in a raw query returns columns in the table's own physical order,
// which doesn't match this model's attribute declaration order - a plain
// ORM read followed by this explicit reconstruction keeps the JSON key
// order byte-for-byte identical to before this migration. Shared by every
// function below that returns a full part_stock row.
function toPhysicalOrder(s) {
  if (!s) return s;
  return {
    stock_id: s.stock_id,
    part_type_id: s.part_type_id,
    part_value: s.part_value,
    status: s.status,
    quantity: s.quantity,
    remark: s.remark,
    updated_at: s.updated_at,
    location: s.location,
    model_name: s.model_name,
    model_number: s.model_number,
    is_active: s.is_active,
    disk_type: s.disk_type,
    disk_interface: s.disk_interface,
    ram_type: s.ram_type,
  };
}

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

  const where = { is_active: true };
  if (part_type_id) where.part_type_id = part_type_id;
  if (status) where.status = status;
  // A line that has dropped to zero is history, not stock - the form should
  // not offer it.
  if (in_stock_only === 'true') where.quantity = { [Op.gt]: 0 };

  const rows = await PartStock.findAll({
    where,
    include: [{ model: PartType, as: 'partType', attributes: ['part_name', 'is_countable', 'tracks_value'] }],
    order: [
      [{ model: PartType, as: 'partType' }, 'sort_order', 'ASC'],
      // Falls back to the model name - accessories have no part_value, so
      // ordering on it alone would group them unpredictably.
      [sequelize.fn('COALESCE', sequelize.col('part_value'), sequelize.col('model_name')), 'ASC'],
      ['status', 'ASC'],
    ],
  });

  return rows.map((row) => {
    const { partType, ...s } = row.get({ plain: true });
    return fixDates({
      stock_id: s.stock_id,
      part_type_id: s.part_type_id,
      part_name: partType ? partType.part_name : null,
      is_countable: partType ? partType.is_countable : null,
      tracks_value: partType ? partType.tracks_value : null,
      part_value: s.part_value,
      model_name: s.model_name,
      model_number: s.model_number,
      disk_type: s.disk_type,
      disk_interface: s.disk_interface,
      ram_type: s.ram_type,
      status: s.status,
      quantity: s.quantity,
      location: s.location,
      remark: s.remark,
      is_active: s.is_active,
      updated_at: s.updated_at,
      // Separate from status: status is the part's condition (working/
      // broken), this is whether there's any left to hand out. A broken
      // line at 0 is still "Broken", just also out of stock.
      stock_state: s.quantity === 0 ? 'Out of Stock' : 'In Stock',
    });
  });
}

// What can actually be fitted right now: working, and more than zero.
async function findAvailable(partTypeId) {
  const where = {
    quantity: { [Op.gt]: 0 },
    is_active: true,
    // Only stock statuses can be fitted. Excluding known-bad ones lets
    // 'Borrowed' and 'Working/Using' through, neither of which describes
    // something sitting on a shelf.
    status: 'Working - IT Stock',
  };
  if (partTypeId) where.part_type_id = partTypeId;

  const rows = await PartStock.findAll({
    where,
    attributes: ['stock_id', 'part_type_id', 'part_value', 'model_name', 'model_number',
      'disk_type', 'disk_interface', 'ram_type', 'status', 'quantity', 'location'],
    include: [{ model: PartType, as: 'partType', attributes: ['part_name', 'tracks_value'] }],
    order: [
      [{ model: PartType, as: 'partType' }, 'sort_order', 'ASC'],
      [sequelize.fn('COALESCE', sequelize.col('part_value'), sequelize.col('model_name')), 'ASC'],
    ],
  });

  return rows.map((row) => {
    const { partType, ...s } = row.get({ plain: true });
    return {
      stock_id: s.stock_id,
      part_type_id: s.part_type_id,
      part_name: partType ? partType.part_name : null,
      tracks_value: partType ? partType.tracks_value : null,
      part_value: s.part_value,
      model_name: s.model_name,
      model_number: s.model_number,
      disk_type: s.disk_type,
      disk_interface: s.disk_interface,
      ram_type: s.ram_type,
      status: s.status,
      quantity: s.quantity,
      location: s.location,
    };
  });
}

async function findById(stockId) {
  const row = await PartStock.findByPk(stockId, {
    include: [{ model: PartType, as: 'partType', attributes: ['part_name', 'is_countable'] }],
  });
  if (!row) return null;
  const { partType, ...s } = row.get({ plain: true });
  return fixDates({
    ...toPhysicalOrder(s),
    part_name: partType ? partType.part_name : null,
    is_countable: partType ? partType.is_countable : null,
  });
}

// Adds to stock, creating the line if this part, value and condition have not
// been seen before. MERGE rather than insert-or-update in code, so two
// simultaneous returns cannot both decide the row is missing.
//
// Accepts an optional external Sequelize transaction from callers that
// already have one open (partBorrowModel.js's markReturned(), partModel.js's
// create()/removeReplacement()), so the stock write commits or rolls back
// with everything else that transaction touched.
async function increment(partTypeId, partValue, status, qty, transaction, extra = {}) {
  const [row] = await sequelize.query(`
      MERGE dbo.part_stock AS target
      USING (SELECT :part_type_id AS part_type_id) AS source
      ON target.part_type_id = source.part_type_id
         AND ISNULL(target.part_value, '')   = ISNULL(:part_value, '')
         AND ISNULL(target.model_name, '')   = ISNULL(:model_name, '')
         AND ISNULL(target.model_number, '') = ISNULL(:model_number, '')
         AND ISNULL(target.disk_type, '')      = ISNULL(:disk_type, '')
         AND ISNULL(target.disk_interface, '') = ISNULL(:disk_interface, '')
        AND ISNULL(target.ram_type, '')       = ISNULL(:ram_type, '')
         AND target.status = :status
      WHEN MATCHED THEN
        UPDATE SET quantity = target.quantity + :qty,
                   updated_at = GETDATE(),
                   location = COALESCE(:location, target.location)
      WHEN NOT MATCHED THEN
        INSERT (part_type_id, part_value, model_name, model_number,
                disk_type, disk_interface, ram_type,
                status, quantity, location, remark)
        VALUES (:part_type_id, :part_value, :model_name, :model_number,
                :disk_type, :disk_interface, :ram_type,
                :status, :qty, :location, :remark)
      OUTPUT INSERTED.*;
    `, {
    replacements: {
      part_type_id: partTypeId,
      part_value: normalizePartValue(partValue) || null,
      model_name: extra.model_name || null,
      model_number: extra.model_number || null,
      disk_type: extra.disk_type || null,
      disk_interface: extra.disk_interface || null,
      ram_type: extra.ram_type || null,
      status: status || 'Working - IT Stock',
      qty: qty ?? 1,
      location: extra.location || null,
      remark: extra.remark || null,
    },
    type: QueryTypes.SELECT,
    transaction,
  });
  return fixDates(row);
}

// Takes from stock. Returns null when the line does not exist or is short,
// rather than letting the quantity go negative - the caller turns that into a
// clear message. Same external-transaction interop as increment() above
// (partBorrowModel.js's create(), partModel.js's create()). The quantity
// arithmetic itself (quantity - N) has no plain-column equivalent in
// Sequelize's update(), so it goes through literal() for that one expression
// - qty is always a plain number by the time it reaches here (Number()
// guards it), never user-supplied SQL text, same as getSummary()'s CASE
// expressions elsewhere in this file. A short/missing line simply matches no
// row, same as the original WHERE quantity >= :qty - rows comes back empty
// either way, same as an empty OUTPUT INSERTED.* did.
async function decrement(stockId, qty, transaction) {
  const n = Number(qty ?? 1);
  const [, rows] = await PartStock.update(
    { quantity: sequelize.literal(`quantity - ${n}`), updated_at: fn('GETDATE') },
    { where: { stock_id: stockId, quantity: { [Op.gte]: n } }, transaction, returning: true },
  );
  return rows && rows[0] ? fixDates(toPhysicalOrder(rows[0].get({ plain: true }))) : null;
}

// Puts quantity back on a specific line by id - a return, where the part is
// going back to exactly where it came from rather than being matched by
// attributes the way increment() does for newly bought-in stock. Same
// external-transaction interop as increment() above (partBorrowModel.js's
// markReturned()/remove(), partModel.js's removeReplacement()).
async function incrementById(stockId, qty, transaction) {
  const n = Number(qty ?? 1);
  const [, rows] = await PartStock.update(
    { quantity: sequelize.literal(`quantity + ${n}`), updated_at: fn('GETDATE') },
    { where: { stock_id: stockId }, transaction, returning: true },
  );
  return rows && rows[0] ? fixDates(toPhysicalOrder(rows[0].get({ plain: true }))) : null;
}

// Manual correction - a stock take, or parts bought in. Self-contained, no
// external transaction, plain single-column update - fn('GETDATE') rather
// than a JS Date so the value is sent as a raw SQL function call, not one of
// Sequelize's own formatted timestamps (which this table's legacy DATETIME
// column would reject - see categoryModel.js's created_at comment).
async function setQuantity(stockId, quantity) {
  const [, rows] = await PartStock.update(
    { quantity, updated_at: fn('GETDATE') },
    { where: { stock_id: stockId }, returning: true },
  );
  return rows && rows[0] ? fixDates(rows[0].get({ plain: true })) : null;
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
//
// Self-contained transaction (no external caller passes one in). The
// clash-detection/merge logic is an explicit lookup chain ahead of a plain
// update-or-merge, same pattern as customFieldModel.setValues() and its
// siblings elsewhere in this migration - not a single MERGE statement, so it
// maps cleanly onto ORM calls rather than needing to stay raw.
async function updateLine(stockId, d) {
  const normalizedPartValue = d.part_value === undefined ? undefined : normalizePartValue(d.part_value);

  return sequelize.transaction(async (transaction) => {
    const existing = await PartStock.findByPk(stockId, { transaction, raw: true });
    if (!existing) return null;

    const resulting = {
      part_value: normalizedPartValue ?? existing.part_value,
      model_name: d.model_name ?? existing.model_name,
      model_number: d.model_number ?? existing.model_number,
      disk_type: d.disk_type ?? existing.disk_type,
      disk_interface: d.disk_interface ?? existing.disk_interface,
      ram_type: d.ram_type ?? existing.ram_type,
      status: d.status ?? existing.status,
    };

    // ISNULL(col,'') = ISNULL(:val,'') reimplemented as null-safe equality
    // per column - real part_stock values are either NULL or an actual
    // string in this data, never a stored empty string, so treating NULL as
    // the only "nothing there" case is equivalent.
    const nullSafe = (col, val) => ({ [col]: val === null || val === undefined ? null : val });

    const clashRow = await PartStock.findOne({
      where: {
        stock_id: { [Op.ne]: stockId },
        part_type_id: existing.part_type_id,
        ...nullSafe('part_value', resulting.part_value),
        ...nullSafe('model_name', resulting.model_name),
        ...nullSafe('model_number', resulting.model_number),
        ...nullSafe('disk_type', resulting.disk_type),
        ...nullSafe('disk_interface', resulting.disk_interface),
        ...nullSafe('ram_type', resulting.ram_type),
        status: resulting.status,
      },
      attributes: ['stock_id'],
      transaction,
      raw: true,
    });

    let result;
    if (clashRow) {
      // existing.quantity is a plain integer straight from the DB, not
      // user-supplied text - literal() here is the same safe pattern
      // getSummary() already uses for its CASE expressions.
      await PartStock.update(
        { quantity: sequelize.literal(`quantity + ${Number(existing.quantity)}`), updated_at: fn('GETDATE') },
        { where: { stock_id: clashRow.stock_id }, transaction },
      );
      const merged = await PartStock.findByPk(clashRow.stock_id, { transaction, raw: true });
      await PartStock.destroy({ where: { stock_id: stockId }, transaction });
      result = { ...toPhysicalOrder(fixDates(merged)), merged_from: stockId };
    } else {
      const values = { updated_at: fn('GETDATE') };
      if (d.quantity !== undefined && d.quantity !== null) values.quantity = d.quantity;
      if (normalizedPartValue !== undefined && normalizedPartValue !== null) values.part_value = normalizedPartValue;
      if (d.model_name !== undefined && d.model_name !== null) values.model_name = d.model_name;
      if (d.model_number !== undefined && d.model_number !== null) values.model_number = d.model_number;
      if (d.disk_type !== undefined && d.disk_type !== null) values.disk_type = d.disk_type;
      if (d.disk_interface !== undefined && d.disk_interface !== null) values.disk_interface = d.disk_interface;
      if (d.ram_type !== undefined && d.ram_type !== null) values.ram_type = d.ram_type;
      if (d.status !== undefined && d.status !== null) values.status = d.status;
      if (d.location !== undefined && d.location !== null) values.location = d.location;
      if (d.remark !== undefined && d.remark !== null) values.remark = d.remark;
      if (d.is_active !== undefined && d.is_active !== null) values.is_active = !!d.is_active;

      await PartStock.update(values, { where: { stock_id: stockId }, transaction });
      const updated = await PartStock.findByPk(stockId, { transaction, raw: true });
      result = toPhysicalOrder(fixDates(updated));
    }

    return result;
  });
}

// Clears part_stock_custom_value first - it references stock_id with no
// cascade, so leaving it behind blocks the delete with a raw FK error
// instead of succeeding cleanly. Same fix as partModel.removeType() needed
// for part_type_custom_field. Self-contained transaction, so this one uses
// sequelize.transaction().
async function remove(stockId) {
  return sequelize.transaction(async (transaction) => {
    // Lazy require - partCustomFieldModel.js imports PartStock from this
    // file eagerly at its own top level, so this file's require of it back
    // must be lazy (verified in both load orders, same technique used
    // throughout this migration).
    const { PartStockCustomValue } = require('./partCustomFieldModel');
    await PartStockCustomValue.destroy({ where: { stock_id: stockId }, transaction });

    const row = await PartStock.findByPk(stockId, { transaction, raw: true });
    if (!row) return null;
    await PartStock.destroy({ where: { stock_id: stockId }, transaction });
    return toPhysicalOrder(fixDates(row));
  });
}

// Totals for a dashboard tile. The two conditional sums have no plain-column
// equivalent in Sequelize's query builder, so they go through fn()+literal()
// for the CASE expression itself - everything around it (the join, the
// group, the order) is still expressed as ORM include/group/order, not a
// hand-written query string.
async function getSummary() {
  return PartStock.findAll({
    attributes: [
      [sequelize.col('partType.part_name'), 'part_name'],
      [sequelize.fn('SUM', sequelize.literal(
        "CASE WHEN status NOT LIKE '%Broken%' AND status NOT LIKE '%Retired%' THEN quantity ELSE 0 END",
      )), 'working'],
      [sequelize.fn('SUM', sequelize.literal(
        "CASE WHEN status LIKE '%Broken%' THEN quantity ELSE 0 END",
      )), 'broken'],
      [sequelize.fn('SUM', sequelize.col('PartStock.quantity')), 'total'],
    ],
    include: [{ model: PartType, as: 'partType', attributes: [] }],
    group: ['partType.part_name', 'partType.sort_order'],
    order: [[{ model: PartType, as: 'partType' }, 'sort_order', 'ASC']],
    subQuery: false,
    raw: true,
  });
}

module.exports = {
  PartStock, PartType,
  parseNumericPartValue,
  findAll, findAvailable, findById,
  increment, decrement, incrementById, setQuantity, updateLine, remove, getSummary,
};
