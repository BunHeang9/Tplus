const { DataTypes, Op } = require('sequelize');
const sequelize = require('../config/sequelize');
const { QueryTypes } = require('sequelize');
const { PartType, PartStock } = require('./partStockModel');
const { Equipment } = require('./equipmentModel');
const { Category } = require('./categoryModel');
const { Employee } = require('./employeeModel');

// Replacing a part of a device rather than the whole thing.
//
// dbo.device_replacement handles whole-device swaps; this handles the RAM
// going from 8GB to 16GB while the laptop stays put.
//
// part_type.equipment_column is what ties the two together: RAM maps to
// equipment.ram, so a replacement updates the device's current specs as well
// as recording what happened. A bag has no column and only leaves history.
//
// Not required by equipmentModel.js (only requires partStockModel.js/
// customFieldModel.js lazily, inside functions, to dodge a load-time cycle -
// never the other way round), so it's safe for this file to import
// PartType/Equipment/Category/Employee and build associations onto them.

const PartReplacement = sequelize.define('PartReplacement', {
  replacement_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  equipment_id: { type: DataTypes.INTEGER, allowNull: false },
  part_type_id: { type: DataTypes.INTEGER, allowNull: false },
  old_value: { type: DataTypes.STRING(400), allowNull: true },
  new_value: { type: DataTypes.STRING(400), allowNull: true },
  replacement_date: { type: DataTypes.DATEONLY, allowNull: false },
  reason: { type: DataTypes.STRING(510), allowNull: true },
  remark: { type: DataTypes.STRING(1000), allowNull: true },
  replaced_by: { type: DataTypes.STRING(200), allowNull: true },
  // Legacy DATETIME with its own DB-side default - allowNull:true even
  // though the column itself is NOT NULL, same reasoning as
  // partBorrowModel.js's PartBorrowRecord.created_at.
  created_at: { type: DataTypes.DATE, allowNull: true },
  action: { type: DataTypes.STRING(20), allowNull: false },
  old_part_status: { type: DataTypes.STRING(50), allowNull: true },
  from_stock: { type: DataTypes.BOOLEAN, allowNull: false },
  new_model_name: { type: DataTypes.STRING(200), allowNull: true },
  new_model_number: { type: DataTypes.STRING(200), allowNull: true },
  new_disk_type: { type: DataTypes.STRING(10), allowNull: true },
  new_disk_interface: { type: DataTypes.STRING(10), allowNull: true },
  new_ram_type: { type: DataTypes.STRING(10), allowNull: true },
  old_model_name: { type: DataTypes.STRING(200), allowNull: true },
  old_model_number: { type: DataTypes.STRING(200), allowNull: true },
  old_disk_type: { type: DataTypes.STRING(10), allowNull: true },
  old_disk_interface: { type: DataTypes.STRING(10), allowNull: true },
  old_ram_type: { type: DataTypes.STRING(10), allowNull: true },
}, {
  tableName: 'part_replacement',
  schema: 'dbo',
  timestamps: false,
});

PartReplacement.belongsTo(PartType, { foreignKey: 'part_type_id', as: 'partType' });
PartReplacement.belongsTo(Equipment, { foreignKey: 'equipment_id', as: 'equipment' });

// Raw queries with no model attribute definition return a plain string for a
// DATE/DATETIME column; the driver this replaces returned a Date object for
// the same column. Converting back keeps every response identical to before
// this migration.
const DATE_FIELDS = ['replacement_date', 'created_at'];
function fixDates(row) {
  if (!row) return row;
  for (const f of DATE_FIELDS) {
    if (row[f]) row[f] = new Date(row[f]);
  }
  return row;
}

// create() and removeReplacement() below need to reject with a specific
// { error: '...' } payload while also rolling back everything the
// transaction did so far - a plain early `return` from inside a
// sequelize.transaction() callback commits rather than rolling back, so
// each of those error paths throws one of these instead, and the outer
// try/catch unwraps it back into the plain error object callers expect.
class ReplacementError extends Error {
  constructor(payload) {
    super(payload.error);
    this.payload = payload;
  }
}

// Only columns that actually exist on dbo.equipment can be mapped, or an
// admin could point a part type at 'banana' and every replacement would fail.
async function validEquipmentColumns() {
  const cols = await sequelize.query(`
    SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = 'equipment' AND TABLE_SCHEMA = 'dbo'
      AND DATA_TYPE IN ('varchar','nvarchar','int')
    ORDER BY COLUMN_NAME
  `, { type: QueryTypes.SELECT });
  return cols.map((r) => r.COLUMN_NAME);
}

// --- part types ---

// Part types, optionally narrowed to one category.
//
// A part with no categories linked applies everywhere - so a newly added part
// type works immediately, rather than being invisible until someone remembers
// to link it. Once an admin links it to anything, it appears only there.
async function findAllTypes(includeInactive = false, categoryId = null) {
  let query = `
    SELECT pt.part_type_id, pt.part_name, pt.description, pt.equipment_column,
           pt.tracks_value, pt.is_countable, pt.sort_order, pt.is_active,
           (SELECT COUNT(*) FROM dbo.part_replacement r
             WHERE r.part_type_id = pt.part_type_id) AS replacement_count,
           (SELECT COUNT(*) FROM dbo.part_type_category ptc
             WHERE ptc.part_type_id = pt.part_type_id) AS category_count,
           (SELECT STRING_AGG(c.category_name, ', ')
              FROM dbo.part_type_category ptc
              JOIN dbo.category c ON ptc.category_id = c.category_id
             WHERE ptc.part_type_id = pt.part_type_id) AS applies_to
    FROM dbo.part_type pt
    WHERE 1=1
  `;
  const replacements = {};

  if (!includeInactive) query += ' AND pt.is_active = 1';

  if (categoryId) {
    query += `
      AND (
        EXISTS (SELECT 1 FROM dbo.part_type_category ptc
                 WHERE ptc.part_type_id = pt.part_type_id
                   AND ptc.category_id = :category_id)
        OR NOT EXISTS (SELECT 1 FROM dbo.part_type_category ptc
                        WHERE ptc.part_type_id = pt.part_type_id)
      )`;
    replacements.category_id = categoryId;
  }

  query += ' ORDER BY pt.sort_order, pt.part_name';

  return sequelize.query(query, { replacements, type: QueryTypes.SELECT });
}

// Which categories a part applies to, plus the ones it could be added to.
async function findTypeCategories(partTypeId) {
  return sequelize.query(`
      SELECT c.category_id, c.category_name,
             CASE WHEN ptc.part_type_id IS NULL THEN 0 ELSE 1 END AS is_linked
      FROM dbo.category c
      LEFT JOIN dbo.part_type_category ptc
             ON ptc.category_id = c.category_id AND ptc.part_type_id = :id
      WHERE c.is_active = 1
      ORDER BY c.category_name
    `, { replacements: { id: partTypeId }, type: QueryTypes.SELECT });
}

// Replaces the whole set in one transaction - a half-saved list would leave
// the part applying to some categories and not others, with no way to tell
// which was intended.
//
// If this part type has no equipment_column yet, linking it to a category
// also auto-provisions a matching equipment custom field (named after the
// part - "Webcam" part type gets a "Webcam" field) and attaches it to every
// category being linked, then points equipment_column at it. That is what
// makes "add a part, link it to a category" enough on its own to show up on
// that category's equipment page, instead of needing a second manual pass
// through /api/custom-fields every time (which is what Mouse, Battery and
// Webcam all needed by hand before this). Skipped entirely if
// equipment_column is already set - an existing RAM/CPU-style real-column
// mapping is never silently overridden.
//
// The customFieldModel.* calls below run on their own connection, outside
// this transaction, exactly as they did before this migration (customField
// definitions/attachments were never part of the atomic part_type_category
// swap) - only the statements that were already inside the transaction move
// to sequelize.transaction() here.
async function setTypeCategories(partTypeId, categoryIds) {
  const customFieldModel = require('./customFieldModel');

  const result = await sequelize.transaction(async (transaction) => {
    await sequelize.query(
      'DELETE FROM dbo.part_type_category WHERE part_type_id = :id',
      { replacements: { id: partTypeId }, transaction },
    );

    for (const categoryId of categoryIds || []) {
      await sequelize.query(
        'INSERT INTO dbo.part_type_category (part_type_id, category_id) VALUES (:part_type_id, :category_id)',
        { replacements: { part_type_id: partTypeId, category_id: categoryId }, transaction },
      );
    }

    let partType = null;
    if ((categoryIds || []).length > 0) {
      const [row] = await sequelize.query(
        'SELECT * FROM dbo.part_type WHERE part_type_id = :id',
        { replacements: { id: partTypeId }, type: QueryTypes.SELECT, transaction },
      );
      partType = row;
    }

    return partType;
  });

  if (result && !result.equipment_column) {
    const fieldKey = customFieldModel.toKey(result.part_name);
    if (fieldKey) {
      let field = await customFieldModel.findByKey(fieldKey);
      if (!field) {
        field = await customFieldModel.create({
          fieldLabel: result.part_name,
          fieldType: 'text',
          createdBy: 'auto (part type category setup)',
        });
      }

      for (const categoryId of categoryIds) {
        await customFieldModel.attachToCategory(categoryId, field.field_id, {});
      }

      await sequelize.query(
        'UPDATE dbo.part_type SET equipment_column = :equipment_column WHERE part_type_id = :id',
        { replacements: { id: partTypeId, equipment_column: fieldKey } },
      );
    }
  }

  return findTypeCategories(partTypeId);
}

// Guards the replacement itself: offering RAM on a camera in the form is one
// mistake, but accepting it would put a value on a device that cannot have one.
async function partAppliesToCategory(partTypeId, categoryId) {
  const [row] = await sequelize.query(`
      SELECT
        (SELECT COUNT(*) FROM dbo.part_type_category
          WHERE part_type_id = :part_type_id) AS total_links,
        (SELECT COUNT(*) FROM dbo.part_type_category
          WHERE part_type_id = :part_type_id AND category_id = :category_id) AS linked_here
    `, { replacements: { part_type_id: partTypeId, category_id: categoryId }, type: QueryTypes.SELECT });
  // No links at all means it applies everywhere.
  return row.total_links === 0 || row.linked_here > 0;
}

async function findTypeById(id) {
  const row = await PartType.findByPk(id, { raw: true });
  return fixDates(row) || null;
}

async function findTypeByName(name) {
  const row = await PartType.findOne({ where: { part_name: name }, raw: true });
  return fixDates(row) || null;
}

async function createType(d) {
  const [row] = await sequelize.query(`
      INSERT INTO dbo.part_type
        (part_name, description, equipment_column, tracks_value, is_countable, sort_order)
      OUTPUT INSERTED.*
      VALUES (:part_name, :description, :equipment_column, :tracks_value,
              :is_countable, :sort_order)
    `, {
    replacements: {
      part_name: d.part_name,
      description: d.description || null,
      equipment_column: d.equipment_column || null,
      tracks_value: d.tracks_value === false ? 0 : 1,
      is_countable: d.is_countable ? 1 : 0,
      sort_order: d.sort_order ?? 99,
    },
    type: QueryTypes.SELECT,
  });
  return fixDates(row);
}

async function updateType(id, d) {
  const [row] = await sequelize.query(`
      UPDATE dbo.part_type
      SET part_name        = COALESCE(:part_name, part_name),
          description      = COALESCE(:description, description),
          equipment_column = COALESCE(:equipment_column, equipment_column),
          tracks_value     = COALESCE(:tracks_value, tracks_value),
          is_countable     = COALESCE(:is_countable, is_countable),
          sort_order       = COALESCE(:sort_order, sort_order),
          is_active        = COALESCE(:is_active, is_active)
      OUTPUT INSERTED.*
      WHERE part_type_id = :id
    `, {
    replacements: {
      id,
      part_name: d.part_name ?? null,
      description: d.description ?? null,
      equipment_column: d.equipment_column ?? null,
      tracks_value: d.tracks_value === undefined ? null : (d.tracks_value ? 1 : 0),
      is_countable: d.is_countable === undefined ? null : (d.is_countable ? 1 : 0),
      sort_order: d.sort_order ?? null,
      is_active: d.is_active === undefined ? null : (d.is_active ? 1 : 0),
    },
    type: QueryTypes.SELECT,
  });
  return fixDates(row) || null;
}

async function countTypeUsage(id) {
  return PartReplacement.count({ where: { part_type_id: id } });
}

// Stock still on the shelf for this part type - deleting the type would
// silently erase that quantity with no history of it ever existing, unlike
// part_replacement usage above which at least leaves a trail.
async function countStockUsage(id) {
  const total = await PartStock.sum('quantity', { where: { part_type_id: id, quantity: { [Op.gt]: 0 } } });
  return total || 0;
}

// Clears the junction/dependent rows first - part_type_category,
// part_type_custom_field, part_type_stock_column and part_stock (plus its
// own part_stock_custom_value children) all reference part_type_id with no
// cascade, so leaving any behind blocks the delete with a raw FK error
// instead of this succeeding cleanly. Safe to clear either way: the category
// and custom field definitions still exist afterward, only this part type's
// attachment to them goes away - and by the time this runs, the caller has
// already confirmed no stock quantity remains, so the part_stock rows left
// are empty lines with nothing to lose. Self-contained transaction (no
// external interop), so this uses sequelize.transaction().
async function removeType(id) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query(
      'DELETE FROM dbo.part_type_category WHERE part_type_id = :id',
      { replacements: { id }, transaction },
    );
    await sequelize.query(
      'DELETE FROM dbo.part_type_custom_field WHERE part_type_id = :id',
      { replacements: { id }, transaction },
    );
    await sequelize.query(
      'DELETE FROM dbo.part_type_stock_column WHERE part_type_id = :id',
      { replacements: { id }, transaction },
    );
    await sequelize.query(`
        DELETE v FROM dbo.part_stock_custom_value v
        JOIN dbo.part_stock s ON s.stock_id = v.stock_id
        WHERE s.part_type_id = :id
      `, { replacements: { id }, transaction });
    await sequelize.query(
      'DELETE FROM dbo.part_stock WHERE part_type_id = :id',
      { replacements: { id }, transaction },
    );

    const [row] = await sequelize.query(
      'DELETE FROM dbo.part_type OUTPUT DELETED.* WHERE part_type_id = :id',
      { replacements: { id }, type: QueryTypes.SELECT, transaction },
    );
    return fixDates(row) || null;
  });
}

// --- replacements ---

// Every part swapped across every device this employee currently owns - the
// per-device history joined out across their whole kit, for an employee-level
// audit trail rather than one device at a time.
async function findByEmployee(employeeId) {
  const rows = await PartReplacement.findAll({
    include: [
      { model: PartType, as: 'partType' },
      {
        model: Equipment, as: 'equipment', required: true, where: { owner_id: employeeId },
        include: [{ model: Category, as: 'category' }, { model: Employee, as: 'owner' }],
      },
    ],
    order: [['replacement_date', 'DESC'], ['replacement_id', 'DESC']],
  });

  return rows.map((row) => {
    const { partType, equipment, ...r } = row.get({ plain: true });
    const owner = equipment.owner;
    return fixDates({
      replacement_id: r.replacement_id,
      equipment_id: r.equipment_id,
      computer_name: equipment.computer_name,
      device_model: equipment.device_model,
      asset_code: equipment.asset_code,
      category_name: equipment.category ? equipment.category.category_name : null,
      owner_name: owner ? owner.full_name : null,
      staff_code: owner ? owner.staff_code : null,
      part_name: partType ? partType.part_name : null,
      action: r.action,
      old_value: r.old_value,
      new_value: r.new_value,
      replacement_date: r.replacement_date,
      new_model_name: r.new_model_name,
      new_model_number: r.new_model_number,
      new_disk_type: r.new_disk_type,
      new_disk_interface: r.new_disk_interface,
      new_ram_type: r.new_ram_type,
      old_model_name: r.old_model_name,
      old_model_number: r.old_model_number,
      old_disk_type: r.old_disk_type,
      old_disk_interface: r.old_disk_interface,
      old_ram_type: r.old_ram_type,
      reason: r.reason,
      remark: r.remark,
      replaced_by: r.replaced_by,
    });
  });
}

async function findByEquipment(equipmentId) {
  const rows = await PartReplacement.findAll({
    where: { equipment_id: equipmentId },
    include: [
      { model: PartType, as: 'partType' },
      { model: Equipment, as: 'equipment', required: true, include: [{ model: Employee, as: 'owner' }] },
    ],
    order: [['replacement_date', 'DESC'], ['replacement_id', 'DESC']],
  });

  return rows.map((row) => {
    const { partType, equipment, ...r } = row.get({ plain: true });
    const owner = equipment.owner;
    return fixDates({
      replacement_id: r.replacement_id,
      equipment_id: r.equipment_id,
      part_type_id: r.part_type_id,
      part_name: partType ? partType.part_name : null,
      equipment_column: partType ? partType.equipment_column : null,
      owner_name: owner ? owner.full_name : null,
      staff_code: owner ? owner.staff_code : null,
      action: r.action,
      old_value: r.old_value,
      new_value: r.new_value,
      replacement_date: r.replacement_date,
      new_model_name: r.new_model_name,
      new_model_number: r.new_model_number,
      new_disk_type: r.new_disk_type,
      new_disk_interface: r.new_disk_interface,
      new_ram_type: r.new_ram_type,
      old_model_name: r.old_model_name,
      old_model_number: r.old_model_number,
      old_disk_type: r.old_disk_type,
      old_disk_interface: r.old_disk_interface,
      old_ram_type: r.old_ram_type,
      reason: r.reason,
      remark: r.remark,
      replaced_by: r.replaced_by,
    });
  });
}

async function findAll(filters = {}) {
  const { category, part_type_id, from, to, q } = filters;

  const equipmentWhere = {};
  if (category) equipmentWhere['$equipment.category.category_name$'] = category;
  if (q) {
    equipmentWhere[Op.or] = [
      { '$equipment.device_name$': { [Op.like]: `%${q}%` } },
      { '$equipment.computer_name$': { [Op.like]: `%${q}%` } },
      { '$equipment.asset_code$': { [Op.like]: `%${q}%` } },
      { '$equipment.owner.full_name$': { [Op.like]: `%${q}%` } },
    ];
  }

  const where = { ...equipmentWhere };
  if (part_type_id) where.part_type_id = part_type_id;
  if (from || to) {
    where.replacement_date = {};
    if (from) where.replacement_date[Op.gte] = from;
    if (to) where.replacement_date[Op.lte] = to;
  }

  const rows = await PartReplacement.findAll({
    where,
    include: [
      { model: PartType, as: 'partType' },
      {
        model: Equipment, as: 'equipment', required: true,
        include: [{ model: Category, as: 'category' }, { model: Employee, as: 'owner' }],
      },
    ],
    order: [['replacement_date', 'DESC'], ['replacement_id', 'DESC']],
    subQuery: false,
  });

  return rows.map((row) => {
    const { partType, equipment, ...r } = row.get({ plain: true });
    const owner = equipment.owner;
    return fixDates({
      replacement_id: r.replacement_id,
      equipment_id: r.equipment_id,
      device_name: equipment.device_name,
      computer_name: equipment.computer_name,
      asset_code: equipment.asset_code,
      device_model: equipment.device_model,
      category_name: equipment.category ? equipment.category.category_name : null,
      owner_name: owner ? owner.full_name : null,
      staff_code: owner ? owner.staff_code : null,
      part_name: partType ? partType.part_name : null,
      action: r.action,
      old_value: r.old_value,
      new_value: r.new_value,
      replacement_date: r.replacement_date,
      new_model_name: r.new_model_name,
      new_model_number: r.new_model_number,
      new_disk_type: r.new_disk_type,
      new_disk_interface: r.new_disk_interface,
      new_ram_type: r.new_ram_type,
      reason: r.reason,
      remark: r.remark,
      replaced_by: r.replaced_by,
    });
  });
}

// Records the replacement and, where the part maps to a column, updates the
// device's current value - both in one transaction. Otherwise the history
// would say 16GB while the device still read 8GB.
//
// old_value is read from the device rather than taken from the caller, so it
// cannot be misreported.

// A device field like `ram` holds one combined number ("16"), not a list of
// physical sticks - so after two 8GB modules get combined by an 'add', the
// system has genuinely forgotten they were ever two separate objects. This
// walks backward through this device+part's own history to recover them: each
// 'add' since the last 'replace' is a real unit that was fitted from stock at
// some point and is still in there, each carrying the type/model it actually
// had (captured in new_ram_type etc. at the time it was fitted). The 'replace'
// that started the chain is the earliest still-installed unit.
//
// If the chain runs out without hitting a 'replace'/'remove' boundary, the
// remaining amount predates this feature (the part the device shipped with,
// never logged) - recovered as one unit with unknown type, since there is
// genuinely no record of what it was.
//
// beforeReplacementId excludes that row and anything logged after it, so the
// same function can answer "what would this replacement have filed to stock"
// when undoing it later, not just when it originally happened.
//
// Accepts a Sequelize transaction from its only callers, create() and
// removeReplacement() below - self-contained now that partStockModel and
// customFieldModel.setValues() both take a Sequelize transaction too.
async function reconstructInstalledUnits(transaction, equipmentId, partTypeId, currentValue, beforeReplacementId = null) {
  let query = `
    SELECT action, new_value, new_model_name, new_model_number,
           new_disk_type, new_disk_interface, new_ram_type
    FROM dbo.part_replacement
    WHERE equipment_id = :equipment_id AND part_type_id = :part_type_id
  `;
  const replacements = { equipment_id: equipmentId, part_type_id: partTypeId };
  if (beforeReplacementId) {
    query += ' AND replacement_id < :before_id';
    replacements.before_id = beforeReplacementId;
  }
  query += ' ORDER BY replacement_date DESC, replacement_id DESC';

  const history = await sequelize.query(query, { replacements, type: QueryTypes.SELECT, transaction });

  const toUnit = (row) => ({
    value: row.new_value,
    model_name: row.new_model_name,
    model_number: row.new_model_number,
    disk_type: row.new_disk_type,
    disk_interface: row.new_disk_interface,
    ram_type: row.new_ram_type,
  });

  const units = [];
  let reachedBoundary = false;
  for (const row of history) {
    if (row.action === 'add') {
      units.push(toUnit(row));
      continue;
    }
    if (row.action === 'replace') {
      units.push(toUnit(row));
    }
    // Both 'replace' and 'remove' mark a known boundary - whatever came
    // before them belonged to a different physical unit, already gone.
    reachedBoundary = true;
    break;
  }

  if (!reachedBoundary) {
    const partStockModel = require('./partStockModel');
    const known = units.reduce(
      (sum, u) => sum + (partStockModel.parseNumericPartValue(u.value) || 0), 0,
    );
    const total = partStockModel.parseNumericPartValue(currentValue) || 0;
    const remainder = total - known;
    if (remainder > 0) {
      units.push({
        value: String(remainder),
        model_name: null, model_number: null,
        disk_type: null, disk_interface: null, ram_type: null,
      });
    } else if (units.length === 0 && currentValue) {
      // Non-numeric value (e.g. an accessory's model) with no history at
      // all - just the one unit, type unknown.
      units.push({
        value: currentValue,
        model_name: null, model_number: null,
        disk_type: null, disk_interface: null, ram_type: null,
      });
    }
  }

  return units;
}

// Self-contained now that partStockModel.increment()/decrement() and
// customFieldModel.setValues() all take a Sequelize transaction. Error
// returns throw ReplacementError so the transaction actually rolls back -
// see the comment on that class above.
async function create(equipmentId, d, actor) {
  const partStockModel = require('./partStockModel');
  const customFieldModel = require('./customFieldModel');

  try {
    return await sequelize.transaction(async (transaction) => {
      const action = d.action || 'replace';
      if (!['replace', 'add', 'remove'].includes(action)) {
        throw new ReplacementError({ error: 'bad_action' });
      }

      const [partType] = await sequelize.query(
        'SELECT * FROM dbo.part_type WHERE part_type_id = :id',
        { replacements: { id: d.part_type_id }, type: QueryTypes.SELECT, transaction },
      );
      if (!partType) {
        throw new ReplacementError({ error: 'unknown_part_type' });
      }

      // Adding only makes sense for something that accumulates.
      if (action === 'add' && !partType.is_countable) {
        throw new ReplacementError({ error: 'not_countable', part_name: partType.part_name });
      }

      // Anything fitted has to come off the shelf. A part bought today is
      // recorded into stock first and then fitted from there - two steps, but
      // it means the stock figures are always right rather than only right
      // when someone remembers.
      //
      // 'remove' is exempt: nothing is being fitted, only taken out.
      if (action !== 'remove' && !d.from_stock_id) {
        throw new ReplacementError({ error: 'stock_required', part_name: partType.part_name });
      }

      // equipment_column can point at either a real dbo.equipment column (RAM,
      // CPU, HD) or a custom field key (Mouse, Bag, Keyboard live in
      // equipment_custom_value instead) - determined once and reused below for
      // both reading the current value and writing the new one.
      const equipmentColumnIsReal = partType.equipment_column
        ? (await validEquipmentColumns()).includes(partType.equipment_column)
        : false;

      // The device is the authority on what was fitted before - reading it
      // rather than trusting the form means old_value cannot be misreported.
      let currentValue = null;
      if (partType.equipment_column) {
        if (equipmentColumnIsReal) {
          const current = await sequelize.query(
            `SELECT [${partType.equipment_column}] AS current_value
             FROM dbo.equipment WHERE equipment_id = :id`,
            { replacements: { id: equipmentId }, type: QueryTypes.SELECT, transaction },
          );
          if (current.length === 0) {
            throw new ReplacementError({ error: 'equipment_not_found' });
          }
          currentValue = current[0].current_value;
        } else {
          const values = await customFieldModel.getValues(equipmentId);
          const match = values.find((v) => v.field_key === partType.equipment_column);
          currentValue = match ? match.field_value : null;
        }
      }

      const oldValue = action === 'add' ? null : (d.old_value ?? currentValue);

      // What the device ends up with.
      let resultingValue;
      if (action === 'remove') {
        resultingValue = null;
      } else if (action === 'add') {
        // Sums, but only when both sides are numbers. Reads past a "GB" suffix
        // either side might have (the stock format is "8 GB"; a device's raw
        // field or a typed-in value might be "8") so neither breaks the sum.
        const currentNum = partStockModel.parseNumericPartValue(currentValue);
        const addedNum = partStockModel.parseNumericPartValue(d.new_value);
        if (Number.isFinite(currentNum) && Number.isFinite(addedNum)) {
          resultingValue = String(currentNum + addedNum);
        } else if (!currentValue) {
          resultingValue = d.new_value ?? null;
        } else {
          // Not numeric - the caller must say what the total is rather than
          // have the system guess.
          throw new ReplacementError({
            error: 'cannot_sum',
            current: currentValue,
            adding: d.new_value,
          });
        }
      } else {
        resultingValue = d.new_value ?? null;
      }

      // The part(s) coming out go back to stock. Each returns at whatever
      // condition the admin says - a stick removed because it failed should
      // not rejoin the working pool and be fitted to the next machine.
      let stockAdded = [];
      // Persisted on the replacement row below so an undo later (or a future
      // audit) knows exactly what accessory came out - reconstruction from
      // history is not an option for these part types, see comment below.
      let outgoingPart = { model_name: null, model_number: null, disk_type: null, disk_interface: null, ram_type: null };
      const removedValue = action === 'add' ? null : (oldValue ?? currentValue);
      // For a model-based accessory there is no equipment_column, so
      // removedValue (derived from old_value) is not the only way to say
      // something came out - old_model_name on its own is just as valid, and
      // is in fact the more precise of the two.
      const hasOutgoingPart = partType.tracks_value
        ? !!removedValue
        : !!(d.old_model_name || removedValue);

      if (hasOutgoingPart && action !== 'add' && d.keep_old !== false) {
        // Reconstruction from history only makes sense for RAM/storage, where
        // 'add' genuinely combines physical units into one number that needs
        // splitting back apart. A model-based accessory (Mouse, Keyboard, Bag)
        // has no equipment column to cross-check against, so there is nothing
        // reliable to reconstruct from - trust exactly what the caller says is
        // coming out rather than an unrelated older record for this same
        // device+part that history happens to contain.
        const units = partType.tracks_value
          ? await reconstructInstalledUnits(
              transaction, equipmentId, d.part_type_id, removedValue,
            )
          : [{
              value: null,
              model_name: d.old_model_name || removedValue,
              model_number: d.old_model_number || null,
              disk_type: d.old_disk_type || null,
              disk_interface: d.old_disk_interface || null,
              ram_type: d.old_ram_type || null,
            }];
        if (!partType.tracks_value) outgoingPart = units[0];
        for (const unit of units) {
          const added = await partStockModel.increment(
            d.part_type_id,
            unit.value === null ? null : String(unit.value),
            d.old_part_status || 'Working - IT Stock',
            1,
            transaction,
            {
              model_name: unit.model_name,
              model_number: unit.model_number,
              disk_type: unit.disk_type,
              disk_interface: unit.disk_interface,
              ram_type: unit.ram_type,
              remark: `Removed from equipment ${equipmentId}`,
            },
          );
          stockAdded.push(added);
        }
      }

      // A part fitted from stock leaves it.
      let stockTaken = null;
      if (d.from_stock_id) {
        stockTaken = await partStockModel.decrement(d.from_stock_id, 1, transaction);
        if (!stockTaken) {
          throw new ReplacementError({ error: 'stock_empty' });
        }
      }

      const [inserted] = await sequelize.query(`
          INSERT INTO dbo.part_replacement
            (equipment_id, part_type_id, action, old_value, new_value,
             old_part_status, from_stock, replacement_date, reason, remark, replaced_by,
             new_model_name, new_model_number, new_disk_type, new_disk_interface, new_ram_type,
             old_model_name, old_model_number, old_disk_type, old_disk_interface, old_ram_type)
          OUTPUT INSERTED.*
          VALUES (:equipment_id, :part_type_id, :action, :old_value, :new_value,
                  :old_part_status, :from_stock, :replacement_date, :reason, :remark, :replaced_by,
                  :new_model_name, :new_model_number, :new_disk_type, :new_disk_interface, :new_ram_type,
                  :old_model_name, :old_model_number, :old_disk_type, :old_disk_interface, :old_ram_type)
        `, {
        replacements: {
          equipment_id: equipmentId,
          part_type_id: d.part_type_id,
          action,
          old_value: oldValue,
          new_value: d.new_value || null,
          old_part_status: hasOutgoingPart ? (d.old_part_status || 'Working - IT Stock') : null,
          from_stock: d.from_stock_id ? 1 : 0,
          // What was actually fitted, carried over from the stock line it
          // came from - so a later replacement knows its real type, not just
          // its size.
          new_model_name: stockTaken?.model_name || null,
          new_model_number: stockTaken?.model_number || null,
          new_disk_type: stockTaken?.disk_type || null,
          new_disk_interface: stockTaken?.disk_interface || null,
          new_ram_type: stockTaken?.ram_type || null,
          // What actually came out, for a model-based accessory - so undoing
          // this later can reverse the correct stock line instead of guessing.
          old_model_name: outgoingPart.model_name,
          old_model_number: outgoingPart.model_number,
          old_disk_type: outgoingPart.disk_type,
          old_disk_interface: outgoingPart.disk_interface,
          old_ram_type: outgoingPart.ram_type,
          replacement_date: d.replacement_date || new Date(),
          reason: d.reason || null,
          remark: d.remark || null,
          replaced_by: actor?.username || null,
        },
        type: QueryTypes.SELECT,
        transaction,
      });

      // The device's own record follows, so its specs and its history agree.
      if (partType.equipment_column) {
        if (equipmentColumnIsReal) {
          await sequelize.query(
            `UPDATE dbo.equipment SET [${partType.equipment_column}] = :value WHERE equipment_id = :id`,
            { replacements: { id: equipmentId, value: resultingValue }, transaction },
          );
        } else {
          await customFieldModel.setValues(
            equipmentId, { [partType.equipment_column]: resultingValue }, transaction,
          );
        }
      }

      return {
        replacement: fixDates(inserted),
        part_name: partType.part_name,
        action,
        old_value: oldValue,
        new_value: d.new_value ?? null,
        resulting_value: resultingValue,
        equipment_updated: !!partType.equipment_column,
        stock_added: stockAdded,
        stock_taken: stockTaken,
      };
    });
  } catch (err) {
    if (err instanceof ReplacementError) return err.payload;
    throw err;
  }
}

// Undoes a mistaken replacement entry: puts the device's field back to what
// it read before, and reverses the stock side-effects, then deletes the
// history row. Mirrors what create() did, in reverse.
//
// 'add' actions are refused - create() stores old_value as NULL for them
// (see oldValue above), since an add has no single "before" value once
// several have stacked. There is nothing reliable to restore the device
// field to, so guessing would risk silently writing a wrong value onto a
// real device rather than leaving the history alone.
//
// Stock reversal is best-effort: only whether a stock line was used is
// recorded (from_stock), not which one (no from_stock_id column), so the
// part fitted is put back by matching on part_type_id/value/status/type
// rather than the exact original line.
//
// Self-contained now that partStockModel and customFieldModel.setValues()
// all take a Sequelize transaction. Error returns throw ReplacementError so
// the transaction actually rolls back - see the comment on that class above.
async function removeReplacement(replacementId, equipmentId) {
  const partStockModel = require('./partStockModel');
  const customFieldModel = require('./customFieldModel');

  try {
    return await sequelize.transaction(async (transaction) => {
      const [record] = await sequelize.query(
        'SELECT * FROM dbo.part_replacement WHERE replacement_id = :id',
        { replacements: { id: replacementId }, type: QueryTypes.SELECT, transaction },
      );
      if (!record || (equipmentId && record.equipment_id !== Number(equipmentId))) {
        throw new ReplacementError({ error: 'not_found' });
      }

      if (record.action === 'add') {
        throw new ReplacementError({ error: 'cannot_undo_add' });
      }

      const [partType] = await sequelize.query(
        'SELECT * FROM dbo.part_type WHERE part_type_id = :id',
        { replacements: { id: record.part_type_id }, type: QueryTypes.SELECT, transaction },
      );

      // Put the device's field back to what it read before this replacement.
      // Same real-column-or-custom-field-key branch as create().
      if (partType && partType.equipment_column) {
        const isRealColumn = (await validEquipmentColumns()).includes(partType.equipment_column);
        if (isRealColumn) {
          await sequelize.query(
            `UPDATE dbo.equipment SET [${partType.equipment_column}] = :value WHERE equipment_id = :id`,
            { replacements: { id: record.equipment_id, value: record.old_value }, transaction },
          );
        } else {
          await customFieldModel.setValues(
            record.equipment_id, { [partType.equipment_column]: record.old_value }, transaction,
          );
        }
      }

      // The part that was fitted (with its real type/model) is handed back to
      // stock, the same way it would be if this replacement were logged in
      // reverse. A model-based accessory has no new_value as its stock identity
      // (it is identified by new_model_name instead) - new_value may still be
      // set on the record, but only as the equipment_column/custom-field sync
      // value, not the part's identity, so it must not be used to match stock
      // here or it creates a bogus second line instead of restoring the real one.
      if (record.from_stock && (record.new_value || record.new_model_name)) {
        const useValueAsPartValue = partType && partType.tracks_value && record.new_value;
        await partStockModel.increment(
          record.part_type_id,
          useValueAsPartValue ? String(record.new_value) : null,
          'Working - IT Stock',
          1,
          transaction,
          {
            model_name: record.new_model_name,
            model_number: record.new_model_number,
            disk_type: record.new_disk_type,
            disk_interface: record.new_disk_interface,
            ram_type: record.new_ram_type,
            remark: `Restored by undoing replacement ${replacementId}`,
          },
        );
      }

      // The old part(s) this replacement set aside into stock are taken back
      // out. For RAM/storage, same split into real physical units create()
      // would have filed, recomputed as of just before this record
      // (beforeReplacementId). For a model-based accessory, reconstruction
      // does not apply (see create()) - the old_model_name etc. columns
      // recorded on this row are exactly what was filed, so they are used
      // directly instead.
      if (record.old_part_status && (record.old_value || record.old_model_name)) {
        const units = (partType && partType.tracks_value)
          ? await reconstructInstalledUnits(
              transaction, record.equipment_id, record.part_type_id,
              record.old_value, record.replacement_id,
            )
          : [{
              value: null,
              model_name: record.old_model_name,
              model_number: record.old_model_number,
              disk_type: record.old_disk_type,
              disk_interface: record.old_disk_interface,
              ram_type: record.old_ram_type,
            }];
        for (const unit of units) {
          const [stockRowFound] = await sequelize.query(`
              SELECT TOP 1 stock_id, quantity FROM dbo.part_stock
              WHERE part_type_id = :part_type_id
                AND ISNULL(part_value, '') = ISNULL(:part_value, '')
                AND status = :status
                AND ISNULL(model_name, '') = ISNULL(:model_name, '')
                AND ISNULL(model_number, '') = ISNULL(:model_number, '')
                AND ISNULL(disk_type, '') = ISNULL(:disk_type, '')
                AND ISNULL(disk_interface, '') = ISNULL(:disk_interface, '')
                AND ISNULL(ram_type, '') = ISNULL(:ram_type, '')
            `, {
            replacements: {
              part_type_id: record.part_type_id,
              part_value: unit.value === null ? null : String(unit.value),
              status: record.old_part_status,
              model_name: unit.model_name,
              model_number: unit.model_number,
              disk_type: unit.disk_type,
              disk_interface: unit.disk_interface,
              ram_type: unit.ram_type,
            },
            type: QueryTypes.SELECT,
            transaction,
          });
          if (stockRowFound && stockRowFound.quantity > 0) {
            await partStockModel.decrement(stockRowFound.stock_id, 1, transaction);
          }
        }
      }

      await sequelize.query(
        'DELETE FROM dbo.part_replacement WHERE replacement_id = :id',
        { replacements: { id: replacementId }, transaction },
      );

      return { removed: fixDates(record) };
    });
  } catch (err) {
    if (err instanceof ReplacementError) return err.payload;
    throw err;
  }
}

module.exports = {
  validEquipmentColumns,
  findAllTypes, findTypeById, findTypeByName, createType, updateType,
  countTypeUsage, countStockUsage, removeType,
  findTypeCategories, setTypeCategories, partAppliesToCategory,
  findByEquipment, findByEmployee, findAll, create, removeReplacement,
};
