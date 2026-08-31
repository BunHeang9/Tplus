const { DataTypes, Op, fn, col, literal } = require('sequelize');
const sequelize = require('../config/sequelize');
const { QueryTypes } = require('sequelize');
const { Category } = require('./categoryModel');
const { Department } = require('./departmentModel');
const { EquipmentStatus } = require('./statusModel');
const { Employee } = require('./employeeModel');

// findAll/findById below go through real Sequelize associations rather than
// sequelize.query() - every other function in this file (assign/update/
// createStock/the unassign* family/findAvailable*/findByDateRange) stays on
// raw sequelize.query(), largely for the same status-name-to-status_id
// subquery reason explained on assign()/update() below, which doesn't map
// onto Model.update(). Two consequences of moving these two to the ORM,
// both deliberate, not oversights:
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

async function updateOwner(id, ownerId) {
  const [, rows] = await Equipment.update(
    { owner_id: ownerId || null },
    { where: { equipment_id: id }, returning: true },
  );
  return rows && rows[0] ? fixDates(rows[0].get({ plain: true })) : null;
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
async function createStock(d) {
  const [row] = await sequelize.query(`
      INSERT INTO dbo.equipment (
        category_id, device_type, device_model, manufacturer,
        asset_code, service_tag, serial_no, product_id,
        mac_address, ip_address, os_type, os_version,
        cpu, ram, hd, windows_license, av_license,
        purchase_date, received_date,
        location, department_id, status, status_id, remark, owner_id
      )
      OUTPUT INSERTED.*
      VALUES (
        :category_id, :device_type, :device_model, :manufacturer,
        :asset_code, :service_tag, :serial_no, :product_id,
        :mac_address, :ip_address, :os_type, :os_version,
        :cpu, :ram, :hd, :windows_license, :av_license,
        :purchase_date, :received_date,
        :location, :department_id, :status,
        (SELECT status_id FROM dbo.equipment_status WHERE status_name = :status),
        :remark, NULL
      )
    `, {
    replacements: {
      category_id: d.category_id,
      device_type: d.device_type || null,
      device_model: d.device_model || null,
      manufacturer: d.manufacturer || null,
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
      status: d.status || 'Working - IT Stock',
      remark: d.remark || null,
      asset_code: d.asset_code || d.equipment_code || null,
    },
    type: QueryTypes.SELECT,
  });
  return fixDates(row);
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
  const [row] = await sequelize.query(`
      UPDATE dbo.equipment
      SET owner_id      = :owner_id,
          assigned_date = COALESCE(:assigned_date, assigned_date),
          computer_name = COALESCE(:computer_name, computer_name),
          ip_address    = COALESCE(:ip_address, ip_address),
          location      = COALESCE(:location, location),
          department_id = COALESCE(:department_id, department_id),
          status        = COALESCE(:status, status),
          status_id     = COALESCE(
                              (SELECT status_id FROM dbo.equipment_status WHERE status_name = :status),
                              status_id)
      OUTPUT INSERTED.*
      WHERE equipment_id = :id
    `, {
    replacements: {
      id,
      owner_id: d.owner_id,
      assigned_date: d.assigned_date || null,
      computer_name: d.computer_name || null,
      ip_address: d.ip_address || null,
      location: d.location || null,
      department_id: d.department_id || null,
      status: d.status || null,
    },
    type: QueryTypes.SELECT,
  });
  return fixDates(row) || null;
}

//Unassign
// name=models/equipmentModel.js
//
// All three take an optional external Sequelize transaction - equipmentController.js's
// unassign() opens one transaction covering "one, several, or all-by-owner"
// in a single call, and rolls back if nothing matched.
async function unassignById(
  equipmentId,
  status = "Working - IT Stock",
  transaction,
) {
  const rows = await sequelize.query(`
    UPDATE dbo.equipment
    SET owner_id = NULL,
        status = :status,
        status_id = (
          SELECT status_id
          FROM dbo.equipment_status
          WHERE status_name = :status
        )
    OUTPUT INSERTED.*
    WHERE equipment_id = :id
  `, { replacements: { id: equipmentId, status }, type: QueryTypes.SELECT, transaction });
  return rows.map(fixDates);
}

async function unassignByIds(
  equipmentIds,
  status = "Working - IT Stock",
  transaction,
) {
  const rows = await sequelize.query(`
    UPDATE dbo.equipment
    SET owner_id = NULL,
        status = :status,
        status_id = (
          SELECT status_id
          FROM dbo.equipment_status
          WHERE status_name = :status
        )
    OUTPUT INSERTED.*
    WHERE equipment_id IN (:ids)
  `, { replacements: { ids: equipmentIds, status }, type: QueryTypes.SELECT, transaction });
  return rows.map(fixDates);
}

async function unassignByOwnerId(
  ownerId,
  status = "Working - IT Stock",
  transaction,
) {
  const rows = await sequelize.query(`
    UPDATE dbo.equipment
    SET owner_id = NULL,
        status = :status,
        status_id = (
          SELECT status_id
          FROM dbo.equipment_status
          WHERE status_name = :status
        )
    OUTPUT INSERTED.*
    WHERE owner_id = :owner_id
  `, { replacements: { owner_id: ownerId, status }, type: QueryTypes.SELECT, transaction });
  return rows.map(fixDates);
}

// What can actually be handed to an employee.
//
// "No owner" alone is not enough: CCTV cameras, racked servers, door sensors
// and network switches have no owner either, but they are mounted in service.
// Those carry status 'Installed' and are excluded, so the assign dropdown
// only offers real stock.
async function findAvailable(category, includeInstalled) {
  let query = `
    SELECT e.equipment_id, e.category_id, c.category_name AS category,
           e.device_type, e.computer_name, e.device_model,
           e.manufacturer, e.asset_code, e.service_tag, e.mac_address, e.ip_address,
           e.cpu, e.ram, e.hd, e.purchase_date, e.received_date,
           e.location, e.department_id, d.department_code AS department,
           e.status, e.remark
    FROM dbo.equipment e
    LEFT JOIN dbo.category c ON e.category_id = c.category_id
    LEFT JOIN dbo.department d ON e.department_id = d.department_id
    LEFT JOIN dbo.equipment_status st ON e.status_id = st.status_id
    WHERE e.owner_id IS NULL
  `;
  const replacements = {};

  // Driven by the is_assignable flag on dbo.equipment_status rather than a
  // hardcoded list, so changing the rule is a data change, not a code change.
  // ?include_installed=true is an escape hatch for assigning an installed
  // device to someone as its custodian.
  if (includeInstalled !== 'true') {
    query += ' AND st.is_assignable = 1';
  }
  if (category) {
    query += ' AND c.category_name = :category';
    replacements.category = category;
  }
  query += ' ORDER BY e.received_date DESC, e.equipment_id DESC';

  const rows = await sequelize.query(query, { replacements, type: QueryTypes.SELECT });
  return rows.map(fixDates);
}

// What can be picked from the assign page's device dropdown: unowned,
// assignable, optionally narrowed by search text/category/status/location.
// Distinct from findAvailable() above - that one is a plain unowned+
// assignable list; this carries a display_name fallback chain and a wider
// filter set the assign form actually uses. Moved here from
// assignController.js, which used to run this query itself.
async function findAvailableForAssign({ q, category, status, location } = {}) {
  let query = `
    SELECT e.*,
           c.category_name,
           s.status_name,
           -- Always null for stock, but present so the column set matches
           -- the replacement page and one table component serves both.
           CAST(NULL AS NVARCHAR(100)) AS owner_name,
           CAST(NULL AS NVARCHAR(100)) AS owner_position,
           CAST(NULL AS VARCHAR(20))   AS owner_department,
           -- What the dropdown shows. Falls through name, hostname, model
           -- and asset code so a device is never an unlabelled row.
           COALESCE(e.computer_name, e.device_name, e.device_model, e.asset_code,
                    CONCAT('Equipment ', e.equipment_id)) AS display_name
    FROM dbo.equipment e
    LEFT JOIN dbo.category c ON e.category_id = c.category_id
    LEFT JOIN dbo.equipment_status s ON e.status_id = s.status_id
    -- No owner is not enough: a wall-mounted camera has no owner either.
    -- is_assignable marks what can actually be handed to a person.
    WHERE e.owner_id IS NULL
      AND s.is_assignable = 1
  `;
  const replacements = {};

  if (q) {
    query += ` AND (
      e.computer_name LIKE :q OR
      e.device_name   LIKE :q OR
      e.asset_code    LIKE :q OR
      e.service_tag   LIKE :q OR
      e.serial_no     LIKE :q OR
      e.device_model  LIKE :q
    )`;
    replacements.q = `%${q}%`;
  }
  if (category) {
    query += ' AND c.category_name = :category';
    replacements.category = category;
  }
  if (status) {
    query += ' AND e.status = :status';
    replacements.status = status;
  }
  if (location) {
    query += ' AND e.location = :location';
    replacements.location = location;
  }

  query += ' ORDER BY c.category_name, display_name';

  const rows = await sequelize.query(query, { replacements, type: QueryTypes.SELECT });
  return rows.map(fixDates);
}

// Falls back to purchase_date where received_date was never recorded.
async function findByDateRange(from, to) {
  const rows = await sequelize.query(`
      SELECT e.equipment_id, e.category_id, c.category_name AS category,
             e.device_type, e.computer_name, e.device_model,
             e.manufacturer, e.asset_code, e.service_tag,
             e.purchase_date, e.received_date, e.assigned_date,
             e.location, e.status,
             emp.full_name AS owner_name,
             emp.position  AS owner_position,
             empd.department_code AS owner_department
      FROM dbo.equipment e
      LEFT JOIN dbo.category c ON e.category_id = c.category_id
      LEFT JOIN dbo.employee emp ON e.owner_id = emp.employee_id
      LEFT JOIN dbo.department empd ON emp.department_id = empd.department_id
      WHERE COALESCE(e.received_date, e.purchase_date) BETWEEN :from AND :to
      ORDER BY COALESCE(e.received_date, e.purchase_date), e.equipment_id
    `, { replacements: { from, to }, type: QueryTypes.SELECT });
  return rows.map(fixDates);
}

// Full detail update. COALESCE means only the fields actually supplied
// change - omitting a field leaves it alone rather than nulling it.
async function update(id, d) {
  const [row] = await sequelize.query(`
      UPDATE dbo.equipment
      SET category_id     = COALESCE(:category_id, category_id),
          device_type     = COALESCE(:device_type, device_type),
          device_model    = COALESCE(:device_model, device_model),
          computer_name   = COALESCE(:computer_name, computer_name),
          manufacturer    = COALESCE(:manufacturer, manufacturer),
          serial_no       = COALESCE(:serial_no, serial_no),
          service_tag     = COALESCE(:service_tag, service_tag),
          product_id      = COALESCE(:product_id, product_id),
          asset_code      = COALESCE(:asset_code, asset_code),
          mac_address     = COALESCE(:mac_address, mac_address),
          ip_address      = COALESCE(:ip_address, ip_address),
          os_type         = COALESCE(:os_type, os_type),
          os_version      = COALESCE(:os_version, os_version),
          cpu             = COALESCE(:cpu, cpu),
          ram             = COALESCE(:ram, ram),
          hd              = COALESCE(:hd, hd),
          windows_license = COALESCE(:windows_license, windows_license),
          av_license      = COALESCE(:av_license, av_license),
          location        = COALESCE(:location, location),
          department_id   = COALESCE(:department_id, department_id),
          status          = COALESCE(:status, status),
          status_id       = COALESCE(
                                (SELECT status_id FROM dbo.equipment_status WHERE status_name = :status),
                                status_id),
          purchase_date   = COALESCE(:purchase_date, purchase_date),
          received_date   = COALESCE(:received_date, received_date),
          assigned_date   = COALESCE(:assigned_date, assigned_date),
          remark          = COALESCE(:remark, remark)

      OUTPUT INSERTED.*
      WHERE equipment_id = :id
    `, {
    replacements: {
      id,
      category_id: d.category_id ?? null,
      device_type: d.device_type ?? null,
      device_model: d.device_model ?? null,
      computer_name: d.computer_name ?? null,
      manufacturer: d.manufacturer ?? null,
      serial_no: d.serial_no ?? null,
      service_tag: d.service_tag ?? null,
      product_id: d.product_id ?? null,
      asset_code: d.asset_code ?? d.equipment_code ?? null,
      mac_address: d.mac_address ?? null,
      ip_address: d.ip_address ?? null,
      os_type: d.os_type ?? null,
      os_version: d.os_version ?? null,
      cpu: d.cpu ?? null,
      ram: d.ram ?? null,
      hd: d.hd ?? null,
      windows_license: d.windows_license ?? null,
      av_license: d.av_license ?? null,
      location: d.location ?? null,
      department_id: d.department_id ?? null,
      status: d.status ?? null,
      purchase_date: d.purchase_date ?? null,
      received_date: d.received_date ?? null,
      assigned_date: d.assigned_date ?? null,
      remark: d.remark ?? null,
    },
    type: QueryTypes.SELECT,
  });
  return fixDates(row) || null;
}

// Counts everything pointing at this equipment. Delete is refused while any
// of these exist, otherwise we would orphan borrow history, antivirus records
// and replacement history.
async function countReferences(id) {
  const [row] = await sequelize.query(`
      SELECT
        (SELECT COUNT(*) FROM dbo.borrow_record      WHERE equipment_id = :id) AS borrow_records,
        (SELECT COUNT(*) FROM dbo.antivirus_install  WHERE equipment_id = :id) AS antivirus_records,
        (SELECT COUNT(*) FROM dbo.server_usage       WHERE equipment_id = :id) AS server_usage_records,
        (SELECT COUNT(*) FROM dbo.device_replacement WHERE old_equipment_id = :id
                                                        OR new_equipment_id = :id) AS replacement_records
    `, { replacements: { id }, type: QueryTypes.SELECT });
  return row;
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
