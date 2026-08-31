const { DataTypes, Op, fn, col, literal, where: sequelizeWhere } = require('sequelize');
const sequelize = require('../config/sequelize');
const { QueryTypes } = require('sequelize');
const { Category } = require('./categoryModel');
const { Department } = require('./departmentModel');
const { EquipmentStatus } = require('./statusModel');
const { Employee } = require('./employeeModel');

// findAll/findById, and since then createStock/update/assign/the unassign*
// family, all go through real Sequelize associations rather than
// sequelize.query(). Two remaining raw exceptions, both deliberate:
// assignToEmployee() reads department_id/location from dbo.employee inside
// the same atomic UPDATE - splitting that into a read-then-write would
// reintroduce a real race condition the original was built to avoid, so it
// stays raw on purpose, not because it's technically blocked. countReferences()
// and remove() are genuinely blocked/transaction-interop (see their own
// comments). Two consequences of moving findAll/findById to the ORM early
// on, both deliberate, not oversights:
//   1. purchase_date/received_date/assigned_date/borrowed_on/due_back come
//      back as plain 'YYYY-MM-DD' strings now, not Date objects - Sequelize's
//      mssql dialect derives the JS type from the SQL column's actual type
//      (`date`), not from how the attribute is declared here, so there is no
//      model declaration that makes a `date` column deserialize as a Date
//      instance. fixDates() is gone because there is nothing it could fix.
//   2. "current open loan" no longer guarantees the *most recent* one if an
//      equipment row somehow ends up with more than one - the app's own
//      business rules (findAvailableToBorrow excludes anything already on
//      loan) mean that should never happen, but unlike the original
//      ORDER BY ... DESC / TOP 1, a plain association take whichever the
//      query planner returns first if it ever does.
const Equipment = sequelize.define('Equipment', {
  equipment_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  device_type: DataTypes.STRING(60),
  device_model: DataTypes.STRING(100),
  manufacturer: DataTypes.STRING(60),
  serial_no: DataTypes.STRING(60),
  asset_code: DataTypes.STRING(30),
  mac_address: DataTypes.STRING(60),
  ip_address: DataTypes.STRING(45),
  owner_id: DataTypes.INTEGER,
  location: DataTypes.STRING(50),
  purchase_date: DataTypes.DATEONLY,
  status: DataTypes.STRING(20),
  remark: DataTypes.STRING(255),
  received_date: DataTypes.DATEONLY,
  assigned_date: DataTypes.DATEONLY,
  department_id: DataTypes.INTEGER,
  category_id: DataTypes.INTEGER,
  status_id: DataTypes.INTEGER,
  computer_name: DataTypes.STRING(100),
  cpu: DataTypes.STRING(100),
  ram: DataTypes.STRING(50),
  hd: DataTypes.STRING(50),
  os_type: DataTypes.STRING(50),
  os_version: DataTypes.STRING(50),
  windows_license: DataTypes.STRING(50),
  av_license: DataTypes.STRING(50),
  service_tag: DataTypes.STRING(100),
  product_id: DataTypes.STRING(100),
  device_name: DataTypes.STRING(150),
  platform: DataTypes.STRING(100),
  server_type: DataTypes.STRING(20),
}, {
  tableName: 'equipment',
  schema: 'dbo',
  timestamps: false,
});

// Only defined here, not in its own file - borrow_record is otherwise
// entirely raw SQL (see borrowModel.js/partBorrowModel.js), and this is the
// one place that needs it as a real association rather than a query.
const BorrowRecord = sequelize.define('BorrowRecord', {
  borrow_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  equipment_id: DataTypes.INTEGER,
  borrower_id: DataTypes.INTEGER,
  borrow_date: DataTypes.DATEONLY,
  expected_return_date: DataTypes.DATEONLY,
  return_date: DataTypes.DATEONLY,
}, {
  tableName: 'borrow_record',
  schema: 'dbo',
  timestamps: false,
});

// Aliased 'equipmentStatus', not 'status' - dbo.equipment already has its
// own real 'status' text column (the legacy mirror of status_id's name),
// and Sequelize refuses an association alias that collides with a real
// attribute name.
Equipment.belongsTo(Category, { foreignKey: 'category_id', as: 'category' });
Equipment.belongsTo(Department, { foreignKey: 'department_id', as: 'department' });
Equipment.belongsTo(EquipmentStatus, { foreignKey: 'status_id', as: 'equipmentStatus' });
Equipment.belongsTo(Employee, { foreignKey: 'owner_id', as: 'owner' });
// Employee->Department ('owner'.department) is defined in employeeModel.js
// itself, not here - already set up by the require above.
Equipment.hasOne(BorrowRecord, { foreignKey: 'equipment_id', as: 'openLoan' });
BorrowRecord.belongsTo(Employee, { foreignKey: 'borrower_id', as: 'borrower' });

// Every findAll/findById include set, so both build the exact same joins.
function equipmentIncludes() {
  return [
    { model: Category, as: 'category' },
    { model: Department, as: 'department' },
    { model: EquipmentStatus, as: 'equipmentStatus' },
    { model: Employee, as: 'owner', include: [{ model: Department, as: 'department' }] },
    {
      model: BorrowRecord,
      as: 'openLoan',
      required: false, // LEFT JOIN - a `where` on an include defaults to
      // required: true (INNER JOIN) otherwise, which would silently drop
      // every equipment row with no open loan, i.e. most of them.
      where: { return_date: null },
      include: [{ model: Employee, as: 'borrower' }],
    },
  ];
}

// Flattens the nested association data Sequelize returns back into the
// same flat field names (owner_name, current_borrow_id, ...) the API
// contract has always used - so callers of findAll()/findById() see no
// difference beyond the date-format change noted above.
function shapeEquipmentRow(instance) {
  const { category, department, equipmentStatus, owner, openLoan, ...rest } = instance.get({ plain: true });
  const ownerDepartment = owner && owner.department;

  return {
    ...rest,
    category_name: category ? category.category_name : null,
    department_code: department ? department.department_code : null,
    department_name: department ? department.department_name : null,
    status_name: equipmentStatus ? equipmentStatus.status_name : null,
    is_assignable: equipmentStatus ? equipmentStatus.is_assignable : null,
    is_borrowable: equipmentStatus ? equipmentStatus.is_borrowable : null,
    owner_name: owner ? owner.full_name : null,
    owner_position: owner ? owner.position : null,
    owner_location: owner ? owner.location : null,
    owner_staff_code: owner ? owner.staff_code : null,
    owner_sex: owner ? owner.sex : null,
    owner_department: ownerDepartment ? ownerDepartment.department_code : null,
    owner_department_name: ownerDepartment ? ownerDepartment.department_name : null,
    current_borrow_id: openLoan ? openLoan.borrow_id : null,
    current_borrower: openLoan && openLoan.borrower ? openLoan.borrower.full_name : null,
    borrowed_on: openLoan ? openLoan.borrow_date : null,
    due_back: openLoan ? openLoan.expected_return_date : null,
  };
}

// Builds the WHERE clause dynamically from whichever filters were supplied.
// Conditions on an included association's column use Sequelize's
// '$alias.column$' syntax rather than a raw string, so nothing is ever
// concatenated into the query - the same injection-safety the old named
// replacements gave, just via the ORM's own escaping instead.
async function findAll(filters = {}) {
  const { category, unowned, location, department, status, q } = filters;

  const conditions = [];

  // Accepts either ?category=Laptop (name) or ?category_id=5
  if (category) conditions.push({ '$category.category_name$': category });
  if (filters.category_id) conditions.push({ category_id: filters.category_id });
  if (unowned === 'true') conditions.push({ owner_id: null });
  if (location) conditions.push({ location });
  if (department) conditions.push({ '$department.department_code$': department });
  if (filters.department_id) conditions.push({ department_id: filters.department_id });
  // Accepts either ?status=Working - IT Stock (name) or ?status_id=2
  if (status) conditions.push({ '$equipmentStatus.status_name$': status });
  if (filters.status_id) conditions.push({ status_id: filters.status_id });
  if (q) {
    // device_name and serial_no matter as much as computer_name/service_tag -
    // a server row typically has device_name set and computer_name null, the
    // opposite of a laptop, so leaving either out silently misses whichever
    // category relies on it.
    const like = { [Op.like]: `%${q}%` };
    conditions.push({
      [Op.or]: [
        { computer_name: like },
        { device_name: like },
        { device_model: like },
        { asset_code: like },
        { serial_no: like },
        { service_tag: like },
        { mac_address: like },
        { ip_address: like },
        { manufacturer: like },
        { '$owner.full_name$': like },
      ],
    });
  }

  const rows = await Equipment.findAll({
    where: conditions.length ? { [Op.and]: conditions } : undefined,
    include: equipmentIncludes(),
    order: [[{ model: Category, as: 'category' }, 'category_name', 'ASC'], ['equipment_id', 'ASC']],
  });
  return rows.map(shapeEquipmentRow);
}

async function findById(id) {
  const row = await Equipment.findByPk(id, { include: equipmentIncludes() });
  return row ? shapeEquipmentRow(row) : null;
}

// Used by every function below - these are all still raw sequelize.query()
// (see the comment above findAll for why), where an unmapped DATE column
// still comes back as a string and needs converting back to a Date object
// to match their existing behavior. Only findAll/findById went through the
// ORM-association rewrite and dropped this - everything below is unchanged.
const DATE_FIELDS = ['purchase_date', 'received_date', 'assigned_date'];
function fixDates(row) {
  if (!row) return row;
  for (const f of DATE_FIELDS) {
    if (row[f]) row[f] = new Date(row[f]);
  }
  return row;
}

// Sequelize's own attribute-declaration order doesn't match dbo.equipment's
// actual physical column order (confirmed against sys.columns) for a
// .create()/.update() result the way a plain read (.findAll()/.findByPk())
// does - every raw-SQL write below this file's ORM rewrite used
// `OUTPUT INSERTED.*`, which does follow physical order, so this
// reconstructs a plain write result into that same order to keep every
// response shape byte-for-byte identical to before.
function toPhysicalOrder(row) {
  if (!row) return row;
  return {
    equipment_id: row.equipment_id,
    device_type: row.device_type,
    device_model: row.device_model,
    manufacturer: row.manufacturer,
    serial_no: row.serial_no,
    asset_code: row.asset_code,
    mac_address: row.mac_address,
    ip_address: row.ip_address,
    owner_id: row.owner_id,
    location: row.location,
    purchase_date: row.purchase_date,
    status: row.status,
    remark: row.remark,
    received_date: row.received_date,
    assigned_date: row.assigned_date,
    department_id: row.department_id,
    category_id: row.category_id,
    status_id: row.status_id,
    computer_name: row.computer_name,
    cpu: row.cpu,
    ram: row.ram,
    hd: row.hd,
    os_type: row.os_type,
    os_version: row.os_version,
    windows_license: row.windows_license,
    av_license: row.av_license,
    service_tag: row.service_tag,
    product_id: row.product_id,
    device_name: row.device_name,
    platform: row.platform,
    server_type: row.server_type,
  };
}

// This file is Category's own hub-side neighbour (Equipment.belongsTo
// already points at it), so the reverse direction is safe to declare right
// here, unlike the same count attempted from categoryModel.js itself, which
// is required BY this file and so can never import Equipment back.
Category.hasMany(Equipment, { foreignKey: 'category_id', as: 'items' });

async function getCategorySummary() {
  const rows = await Category.findAll({
    attributes: [
      'category_id', ['category_name', 'category'],
      [fn('COUNT', col('items.equipment_id')), 'total_items'],
      [fn('SUM', literal("CASE WHEN [items].[owner_id] IS NULL THEN 1 ELSE 0 END")), 'no_owner'],
      [fn('SUM', literal("CASE WHEN [items].[owner_id] IS NOT NULL THEN 1 ELSE 0 END")), 'has_owner'],
    ],
    include: [{ model: Equipment, as: 'items', attributes: [], required: false }],
    group: ['Category.category_id', 'Category.category_name'],
    order: [['category_name', 'ASC']],
    subQuery: false,
    raw: true,
  });
  return rows;
}

// Returns the same full shape findById()/findAll() give (owner_name,
// category_name, ...), not just the bare updated row - a caller showing
// "assigned to X" right after this call would otherwise have owner_id (a
// number) and nothing to display a name with, forcing a second fetch just
// to get the name back.
async function updateOwner(id, ownerId) {
  const [count] = await Equipment.update(
    { owner_id: ownerId || null },
    { where: { equipment_id: id } },
  );
  if (count === 0) return null;
  return findById(id);
}

// --- Stock workflow ---

async function findByEquipmentCode(code) {
  return Equipment.findOne({
    where: { asset_code: code },
    attributes: ['equipment_id', 'computer_name', 'device_model'],
    raw: true,
  });
}

async function findByServiceTag(tag) {
  return Equipment.findOne({
    where: { service_tag: tag },
    attributes: ['equipment_id', 'computer_name'],
    raw: true,
  });
}

// New stock always starts with owner_id NULL - assignment is a separate step.
// New stock always starts with owner_id NULL - assignment is a separate
// step. status_id is resolved by a plain lookup first rather than a
// subquery embedded in the INSERT - two ORM calls instead of one raw
// statement, deliberately: this only runs once per new row (not a hot
// path), and there's no real correctness difference since nothing else
// can be reading/writing this specific not-yet-created row in between.
async function createStock(d) {
  const status = d.status || 'Working - IT Stock';
  const statusRow = await EquipmentStatus.findOne({ where: { status_name: status }, attributes: ['status_id'], raw: true });

  const row = await Equipment.create({
    category_id: d.category_id,
    device_type: d.device_type || null,
    device_name: d.device_name || null,
    server_type: d.server_type || null,
    device_model: d.device_model || null,
    manufacturer: d.manufacturer || null,
    asset_code: d.asset_code || d.equipment_code || null,
    service_tag: d.service_tag || null,
    serial_no: d.serial_no || null,
    product_id: d.product_id || null,
    mac_address: d.mac_address || null,
    ip_address: d.ip_address || null,
    os_type: d.os_type || null,
    os_version: d.os_version || null,
    cpu: d.cpu || null,
    ram: d.ram || null,
    hd: d.hd || null,
    windows_license: d.windows_license || null,
    av_license: d.av_license || null,
    purchase_date: d.purchase_date || null,
    received_date: d.received_date || null,
    location: d.location || null,
    department_id: d.department_id || null,
    status,
    status_id: statusRow ? statusRow.status_id : null,
    remark: d.remark || null,
    owner_id: null,
  });
  return fixDates(toPhysicalOrder(row.get({ plain: true })));
}

// Every device this employee owns, with raw equipment columns plus category
// and status names attached. Used to build the per-category equipment cards
// on an employee's page - one row per device, grouped by category downstream.
async function findByOwner(ownerId) {
  const rows = await Equipment.findAll({
    where: { owner_id: ownerId },
    include: [
      { model: Category, as: 'category' },
      { model: EquipmentStatus, as: 'equipmentStatus' },
    ],
    order: [
      [{ model: Category, as: 'category' }, 'category_name', 'ASC'],
      ['equipment_id', 'ASC'],
    ],
  });

  return rows.map((row) => {
    const { category, equipmentStatus, ...e } = row.get({ plain: true });
    return fixDates({
      ...e,
      category_name: category ? category.category_name : null,
      status_name: equipmentStatus ? equipmentStatus.status_name : null,
    });
  });
}

async function findWithOwnerName(id) {
  const row = await Equipment.findByPk(id, {
    attributes: ['equipment_id', 'owner_id', 'computer_name', 'device_model'],
    include: [{ model: Employee, as: 'owner', attributes: ['full_name'] }],
  });
  if (!row) return null;

  const { owner, ...e } = row.get({ plain: true });
  return { ...e, current_owner: owner ? owner.full_name : null };
}

// Assigns a device to an employee, inheriting department and location from
// them rather than asking the caller to supply matching values - so the
// device and the person can never disagree about where they are. One atomic
// UPDATE with correlated subqueries rather than a read-then-write, so the
// employee's department/location can't change between reading and writing.
// Moved here from assignController.js, which used to run this query itself.
async function assignToEmployee(id, employeeId, { status, assignedDate } = {}) {
  const [row] = await sequelize.query(`
      UPDATE dbo.equipment
      SET owner_id      = :employee_id,
          status        = :status,
          status_id     = (SELECT status_id FROM dbo.equipment_status WHERE status_name = :status),
          assigned_date = :assigned_date,
          -- Both follow the owner. Asking for them separately invites the
          -- device and the person to disagree about where they are.
          department_id = (SELECT department_id FROM dbo.employee WHERE employee_id = :employee_id),
          location      = COALESCE(
                            (SELECT location FROM dbo.employee WHERE employee_id = :employee_id),
                            location)
      OUTPUT INSERTED.*
      WHERE equipment_id = :id
    `, {
    replacements: {
      id,
      employee_id: employeeId,
      status: status || 'Working/Using',
      assigned_date: assignedDate || new Date(),
    },
    type: QueryTypes.SELECT,
  });
  return fixDates(row) || null;
}

async function assign(id, d) {
  const values = { owner_id: d.owner_id ?? null };
  if (d.assigned_date) values.assigned_date = d.assigned_date;
  if (d.computer_name) values.computer_name = d.computer_name;
  if (d.ip_address) values.ip_address = d.ip_address;
  if (d.location) values.location = d.location;
  if (d.department_id) values.department_id = d.department_id;
  if (d.status) {
    values.status = d.status;
    const statusRow = await EquipmentStatus.findOne({ where: { status_name: d.status }, attributes: ['status_id'], raw: true });
    if (statusRow) values.status_id = statusRow.status_id;
  }

  const [, rows] = await Equipment.update(values, { where: { equipment_id: id }, returning: true });
  if (!rows || !rows[0]) return null;
  return fixDates(toPhysicalOrder(rows[0].get({ plain: true })));
}

//Unassign
// name=models/equipmentModel.js
//
// All three take an optional external Sequelize transaction - equipmentController.js's
// unassign() opens one transaction covering "one, several, or all-by-owner"
// in a single call, and rolls back if nothing matched.
// Shared by all three below - the status_id lookup itself joins the same
// transaction (when one is passed in) so it sees the same in-flight state
// as the update it feeds, same as the original subquery running inside the
// same statement/transaction.
async function resolveStatusId(statusName, transaction) {
  const row = await EquipmentStatus.findOne({
    where: { status_name: statusName }, attributes: ['status_id'], raw: true, transaction,
  });
  return row ? row.status_id : null;
}

async function unassignById(
  equipmentId,
  status = "Working - IT Stock",
  transaction,
) {
  const status_id = await resolveStatusId(status, transaction);
  const [, rows] = await Equipment.update(
    { owner_id: null, status, status_id },
    { where: { equipment_id: equipmentId }, returning: true, transaction },
  );
  return (rows || []).map((r) => fixDates(toPhysicalOrder(r.get({ plain: true }))));
}

async function unassignByIds(
  equipmentIds,
  status = "Working - IT Stock",
  transaction,
) {
  const status_id = await resolveStatusId(status, transaction);
  const [, rows] = await Equipment.update(
    { owner_id: null, status, status_id },
    { where: { equipment_id: { [Op.in]: equipmentIds } }, returning: true, transaction },
  );
  return (rows || []).map((r) => fixDates(toPhysicalOrder(r.get({ plain: true }))));
}

async function unassignByOwnerId(
  ownerId,
  status = "Working - IT Stock",
  transaction,
) {
  const status_id = await resolveStatusId(status, transaction);
  const [, rows] = await Equipment.update(
    { owner_id: null, status, status_id },
    { where: { owner_id: ownerId }, returning: true, transaction },
  );
  return (rows || []).map((r) => fixDates(toPhysicalOrder(r.get({ plain: true }))));
}

// What can actually be handed to an employee.
//
// "No owner" alone is not enough: CCTV cameras, racked servers, door sensors
// and network switches have no owner either, but they are mounted in service.
// Those carry status 'Installed' and are excluded, so the assign dropdown
// only offers real stock.
async function findAvailable(category, includeInstalled) {
  const where = { owner_id: null };
  if (category) where['$category.category_name$'] = category;

  // Driven by the is_assignable flag on dbo.equipment_status rather than a
  // hardcoded list, so changing the rule is a data change, not a code change.
  // ?include_installed=true is an escape hatch for assigning an installed
  // device to someone as its custodian. Same LEFT-JOIN-with-a-filter vs.
  // plain-LEFT-JOIN distinction the original raw query made: filtering
  // is_assignable on the joined table behaves like an inner join (a row
  // with no status match fails the =1 test either way), so `required` only
  // flips to true in that branch.
  const equipmentStatusInclude = { model: EquipmentStatus, as: 'equipmentStatus', attributes: [] };
  if (includeInstalled !== 'true') {
    equipmentStatusInclude.where = { is_assignable: true };
    equipmentStatusInclude.required = true;
  } else {
    equipmentStatusInclude.required = false;
  }

  const rows = await Equipment.findAll({
    where,
    attributes: [
      'equipment_id', 'category_id', 'device_type', 'computer_name', 'device_model',
      'manufacturer', 'asset_code', 'service_tag', 'mac_address', 'ip_address',
      'cpu', 'ram', 'hd', 'purchase_date', 'received_date',
      'location', 'department_id', 'status', 'remark',
    ],
    include: [
      { model: Category, as: 'category', attributes: ['category_name'] },
      { model: Department, as: 'department', attributes: ['department_code'] },
      equipmentStatusInclude,
    ],
    order: [['received_date', 'DESC'], ['equipment_id', 'DESC']],
    subQuery: false,
  });

  return rows.map((row) => {
    const { category: cat, department, equipmentStatus, ...e } = row.get({ plain: true });
    return fixDates({
      equipment_id: e.equipment_id,
      category_id: e.category_id,
      category: cat ? cat.category_name : null,
      device_type: e.device_type,
      computer_name: e.computer_name,
      device_model: e.device_model,
      manufacturer: e.manufacturer,
      asset_code: e.asset_code,
      service_tag: e.service_tag,
      mac_address: e.mac_address,
      ip_address: e.ip_address,
      cpu: e.cpu,
      ram: e.ram,
      hd: e.hd,
      purchase_date: e.purchase_date,
      received_date: e.received_date,
      location: e.location,
      department_id: e.department_id,
      department: department ? department.department_code : null,
      status: e.status,
      remark: e.remark,
    });
  });
}

// What can be picked from the assign page's device dropdown: unowned,
// assignable, optionally narrowed by search text/category/status/location.
// Distinct from findAvailable() above - that one is a plain unowned+
// assignable list; this carries a display_name fallback chain and a wider
// filter set the assign form actually uses. Moved here from
// assignController.js, which used to run this query itself.
async function findAvailableForAssign({ q, category, status, location } = {}) {
  // No owner is not enough: a wall-mounted camera has no owner either.
  // is_assignable marks what can actually be handed to a person.
  const where = { owner_id: null };
  if (category) where['$category.category_name$'] = category;
  if (status) where.status = status;
  if (location) where.location = location;
  if (q) {
    const like = { [Op.like]: `%${q}%` };
    where[Op.or] = [
      { computer_name: like }, { device_name: like }, { asset_code: like },
      { service_tag: like }, { serial_no: like }, { device_model: like },
    ];
  }

  // What the dropdown shows. Falls through name, hostname, model and asset
  // code so a device is never an unlabelled row - kept as a SQL expression
  // (rather than computed only in JS) purely so ORDER BY sorts on exactly
  // what SQL Server's COALESCE/CONCAT produce, with no risk of a JS string
  // comparison disagreeing with it.
  const displayNameSql = "COALESCE(computer_name, device_name, device_model, asset_code, CONCAT('Equipment ', equipment_id))";

  const rows = await Equipment.findAll({
    where,
    include: [
      { model: Category, as: 'category' },
      { model: EquipmentStatus, as: 'equipmentStatus', where: { is_assignable: true }, required: true },
    ],
    order: [
      [{ model: Category, as: 'category' }, 'category_name', 'ASC'],
      [literal(displayNameSql), 'ASC'],
    ],
    subQuery: false,
  });

  return rows.map((row) => {
    const { category: cat, equipmentStatus, ...e } = row.get({ plain: true });
    return fixDates({
      ...e,
      category_name: cat ? cat.category_name : null,
      status_name: equipmentStatus ? equipmentStatus.status_name : null,
      // Always null for stock, but present so the column set matches the
      // replacement page and one table component serves both.
      owner_name: null,
      owner_position: null,
      owner_department: null,
      display_name: e.computer_name || e.device_name || e.device_model || e.asset_code || `Equipment ${e.equipment_id}`,
    });
  });
}

// Falls back to purchase_date where received_date was never recorded.
async function findByDateRange(from, to) {
  const coalescedDate = fn('COALESCE', col('received_date'), col('purchase_date'));

  const rows = await Equipment.findAll({
    where: sequelizeWhere(coalescedDate, { [Op.between]: [from, to] }),
    include: [
      { model: Category, as: 'category' },
      { model: Employee, as: 'owner', include: [{ model: Department, as: 'department' }] },
    ],
    order: [[coalescedDate, 'ASC'], ['equipment_id', 'ASC']],
  });

  return rows.map((row) => {
    const { category, owner, ...e } = row.get({ plain: true });
    const ownerDepartment = owner && owner.department;
    return fixDates({
      equipment_id: e.equipment_id,
      category_id: e.category_id,
      category: category ? category.category_name : null,
      device_type: e.device_type,
      computer_name: e.computer_name,
      device_model: e.device_model,
      manufacturer: e.manufacturer,
      asset_code: e.asset_code,
      service_tag: e.service_tag,
      purchase_date: e.purchase_date,
      received_date: e.received_date,
      assigned_date: e.assigned_date,
      location: e.location,
      status: e.status,
      owner_name: owner ? owner.full_name : null,
      owner_position: owner ? owner.position : null,
      owner_department: ownerDepartment ? ownerDepartment.department_code : null,
    });
  });
}

// Full detail update. COALESCE means only the fields actually supplied
// change - omitting a field leaves it alone rather than nulling it.
async function update(id, d) {
  const values = {};
  // Both undefined and explicit null mean "leave alone" here, same as the
  // original COALESCE(:x, x) - a caller sending null never had a way to
  // blank a field out through this endpoint, only skip it or set a real
  // value.
  const maybeSet = (key, val) => { if (val !== undefined && val !== null) values[key] = val; };
  maybeSet('category_id', d.category_id);
  maybeSet('device_type', d.device_type);
  maybeSet('device_name', d.device_name);
  maybeSet('server_type', d.server_type);
  maybeSet('device_model', d.device_model);
  maybeSet('computer_name', d.computer_name);
  maybeSet('manufacturer', d.manufacturer);
  maybeSet('serial_no', d.serial_no);
  maybeSet('service_tag', d.service_tag);
  maybeSet('product_id', d.product_id);
  maybeSet('asset_code', d.asset_code ?? d.equipment_code);
  maybeSet('mac_address', d.mac_address);
  maybeSet('ip_address', d.ip_address);
  maybeSet('os_type', d.os_type);
  maybeSet('os_version', d.os_version);
  maybeSet('cpu', d.cpu);
  maybeSet('ram', d.ram);
  maybeSet('hd', d.hd);
  maybeSet('windows_license', d.windows_license);
  maybeSet('av_license', d.av_license);
  maybeSet('location', d.location);
  maybeSet('department_id', d.department_id);
  maybeSet('purchase_date', d.purchase_date);
  maybeSet('received_date', d.received_date);
  maybeSet('assigned_date', d.assigned_date);
  maybeSet('remark', d.remark);

  if (d.status !== undefined && d.status !== null) {
    values.status = d.status;
    const statusRow = await EquipmentStatus.findOne({ where: { status_name: d.status }, attributes: ['status_id'], raw: true });
    if (statusRow) values.status_id = statusRow.status_id;
  }

  let row;
  if (Object.keys(values).length === 0) {
    row = await Equipment.findByPk(id, { raw: true });
  } else {
    const [, rows] = await Equipment.update(values, { where: { equipment_id: id }, returning: true });
    row = rows && rows[0] ? rows[0].get({ plain: true }) : null;
  }
  if (!row) return null;

  return fixDates(toPhysicalOrder(row));
}

// Counts everything pointing at this equipment. Delete is refused while any
// of these exist, otherwise we would orphan borrow history, antivirus records
// and replacement history.
// Counts across borrowModel/antivirusInstallModel/serverUsageModel/
// deviceReplacementModel's own tables - all four of those files import
// Equipment from this one at their own top level, so this file importing
// any of them back at ITS top level would be a real require cycle. Lazy
// instead (same technique as categoryModel.js/statusModel.js/
// departmentModel.js's own correlated counts): by the time any request
// handler calls countReferences(), the whole app has already finished
// starting up and all four are already loaded.
async function countReferences(id) {
  const { BorrowRecord } = require('./borrowModel');
  const { AntivirusInstall } = require('./antivirusInstallModel');
  const { ServerUsage } = require('./serverUsageModel');
  const { DeviceReplacement } = require('./deviceReplacementModel');

  const [borrow_records, antivirus_records, server_usage_records, replacement_records] = await Promise.all([
    BorrowRecord.count({ where: { equipment_id: id } }),
    AntivirusInstall.count({ where: { equipment_id: id } }),
    ServerUsage.count({ where: { equipment_id: id } }),
    DeviceReplacement.count({ where: { [Op.or]: [{ old_equipment_id: id }, { new_equipment_id: id }] } }),
  ]);
  return { borrow_records, antivirus_records, server_usage_records, replacement_records };
}

// Captures the row into the recycle bin before removing it, both in one
// transaction - so a failed delete cannot leave an orphaned bin entry, and a
// failed bin write cannot lose the equipment.
//
// Custom field values go into the snapshot too, otherwise restoring would
// bring back the device without whatever an admin had recorded against it.
//
// Self-contained now that recycleBinModel.create() itself takes a Sequelize
// transaction. customFieldModel.getValues() runs on its own connection,
// outside this transaction, exactly as it did before this migration.
async function remove(id, actor) {
  const recycleBinModel = require('./recycleBinModel');
  const customFieldModel = require('./customFieldModel');

  return sequelize.transaction(async (transaction) => {
    const [equipment] = await sequelize.query(
      'SELECT * FROM dbo.equipment WHERE equipment_id = :id',
      { replacements: { id }, type: QueryTypes.SELECT, transaction },
    );
    if (!equipment) return null;

    let customValues = [];
    try {
      customValues = await customFieldModel.getValues(id);
    } catch {
      // A device in a category with no custom fields has none - not an error.
    }

    const label =
      equipment.device_name ||
      equipment.computer_name ||
      equipment.device_model ||
      `Equipment ${id}`;

    await recycleBinModel.create(
      {
        entityType: 'equipment',
        entityId: id,
        entityLabel: label,
        entityData: { ...equipment, _custom_values: customValues },
        actor,
        reason: 'Equipment deleted',
      },
      transaction,
    );

    await sequelize.query(
      'DELETE FROM dbo.equipment WHERE equipment_id = :id',
      { replacements: { id }, transaction },
    );

    return equipment;
  });
}

module.exports = {
  Equipment, // exported so other files can build associations against this
  // same table definition (and its own category/department/owner
  // associations) rather than redefining it.
  findAll,
  update,
  countReferences,
  remove,
  findById,
  getCategorySummary,
  updateOwner,
  findByOwner,
  findByEquipmentCode,
  findByServiceTag,
  createStock,
  findWithOwnerName,
  assign,
  assignToEmployee,
  unassignById,
  unassignByIds,
  unassignByOwnerId,
  findAvailable,
  findAvailableForAssign,
  findByDateRange,
};
