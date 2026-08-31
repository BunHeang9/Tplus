const { DataTypes, Op, fn, col } = require('sequelize');
const sequelize = require('../config/sequelize');
const { QueryTypes } = require('sequelize');
const recycleBinModel = require("./recycleBinModel");
const { Department } = require('./departmentModel');

// All database access for employees lives here.
// Controllers call these functions; they never write SQL themselves.

const Employee = sequelize.define('Employee', {
  employee_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  full_name: { type: DataTypes.STRING(150), allowNull: false },
  staff_code: { type: DataTypes.STRING(30), allowNull: true },
  phone: { type: DataTypes.STRING(30), allowNull: true },
  sex: { type: DataTypes.STRING(10), allowNull: true },
  location: { type: DataTypes.STRING(50), allowNull: true },
  position: { type: DataTypes.STRING(255), allowNull: true },
  department_id: { type: DataTypes.INTEGER, allowNull: true },
  // Has a DB-side default (1) - declared nullable here (not the real schema)
  // purely so create(), which never sets it, omits the column from the
  // INSERT and lets the DB default fill it in.
  is_active: { type: DataTypes.BOOLEAN, allowNull: true },
  left_date: { type: DataTypes.DATEONLY, allowNull: true },
}, {
  tableName: 'employee',
  schema: 'dbo',
  timestamps: false,
});

// Defined once, here, since employeeModel.js is Employee's natural owner -
// equipmentModel.js (which also needs Employee->Department for the owner's
// department) relies on this having already run by requiring this file
// before using the association itself.
Employee.belongsTo(Department, { foreignKey: 'department_id', as: 'department' });

// Active employees only by default - a leaver should not appear in an assign
// or borrow dropdown. Pass includeInactive to get everyone, e.g. for an admin
// screen or when resolving a name on an old record.
async function findAll(includeInactive = false) {
  const rows = await Employee.findAll({
    where: includeInactive ? {} : { is_active: true },
    include: [{ model: Department, as: 'department' }],
    order: [['full_name', 'ASC']],
  });

  return rows.map((row) => {
    const { department, ...emp } = row.get({ plain: true });
    return {
      employee_id: emp.employee_id,
      full_name: emp.full_name,
      staff_code: emp.staff_code,
      phone: emp.phone,
      sex: emp.sex,
      location: emp.location,
      position: emp.position,
      department_id: emp.department_id,
      department_code: department ? department.department_code : null,
      department_name: department ? department.department_name : null,
      is_active: emp.is_active,
      left_date: emp.left_date,
    };
  });
}

// One row per employee per device they own (owner_id, not borrowing) - via
// LEFT JOIN so an employee with nothing owned still gets one row, with the
// equipment columns null. That is what lets a report show "no equipment"
// employees alongside everyone else instead of silently dropping them.
//
// equipmentModel.js already imports Employee from this file at ITS top
// level, so this file importing Equipment back at ITS OWN top level would
// be a real require cycle. Lazy instead - by the time any request handler
// calls findAllWithEquipment(), the whole app has already finished
// starting up and equipmentModel.js is already loaded.
async function findAllWithEquipment(includeInactive = false) {
  const { Equipment } = require('./equipmentModel');
  const { Category } = require('./categoryModel');

  // Declared once, guarded - re-declaring the same association on every
  // call would eventually throw ("you have used the alias ownedEquipment
  // in two separate associations").
  if (!Employee.associations.ownedEquipment) {
    Employee.hasMany(Equipment, { foreignKey: 'owner_id', as: 'ownedEquipment' });
  }

  const employees = await Employee.findAll({
    where: includeInactive ? {} : { is_active: true },
    include: [
      { model: Department, as: 'department' },
      {
        model: Equipment, as: 'ownedEquipment', required: false,
        include: [{ model: Category, as: 'category' }],
      },
    ],
    // All three sort keys pushed through SQL (not a JS .sort() afterward) -
    // SQL Server's default collation is case-insensitive, but a plain JS
    // string comparison isn't ('bounngern' sorts after 'Bounphahaksa' in
    // JS, before it in SQL) - caught live by this exact mismatch before
    // this fix.
    order: [
      ['full_name', 'ASC'],
      [{ model: Equipment, as: 'ownedEquipment' }, { model: Category, as: 'category' }, 'category_name', 'ASC'],
      [{ model: Equipment, as: 'ownedEquipment' }, 'computer_name', 'ASC'],
    ],
    subQuery: false,
  });

  // One employee with N equipment becomes N rows here (or 1 all-null-
  // equipment row if they own nothing) - flattening the nested include back
  // into the original flat, one-row-per-device shape.
  const rows = [];
  for (const row of employees) {
    const { department, ownedEquipment, ...emp } = row.get({ plain: true });
    const devices = ownedEquipment && ownedEquipment.length > 0 ? ownedEquipment : [null];
    for (const e of devices) {
      rows.push({
        employee_id: emp.employee_id,
        full_name: emp.full_name,
        staff_code: emp.staff_code,
        position: emp.position,
        employee_location: emp.location,
        department_code: department ? department.department_code : null,
        department_name: department ? department.department_name : null,
        is_active: emp.is_active,
        equipment_id: e ? e.equipment_id : null,
        category_name: e && e.category ? e.category.category_name : null,
        computer_name: e ? e.computer_name : null,
        device_model: e ? e.device_model : null,
        manufacturer: e ? e.manufacturer : null,
        asset_code: e ? e.asset_code : null,
        service_tag: e ? e.service_tag : null,
        device_status: e ? e.status : null,
        device_location: e ? e.location : null,
      });
    }
  }

  return rows;
}

async function findById(id) {
  const row = await Employee.findByPk(id, {
    include: [{ model: Department, as: 'department' }],
  });
  if (!row) return null;

  const { department, ...rest } = row.get({ plain: true });
  return {
    ...rest,
    department_code: department ? department.department_code : null,
    department_name: department ? department.department_name : null,
  };
}

// The "search employee, see everything" query - joins equipment,
// server details and antivirus status into one flat result set.
async function searchWithEquipment(name) {
  return sequelize.query(`
      SELECT
        emp.employee_id,
        emp.full_name AS owner_name,
        emp.position AS employee_position,
        emp.department_id AS employee_department_id,
        empd.department_code AS employee_department,
        empd.department_name AS employee_department_name,
        emp.location AS employee_location,
        emp.sex,
        emp.staff_code,
        emp.phone,
        e.equipment_id,
        e.category_id,
        c.category_name AS category,
        e.device_type,
        e.computer_name,
        e.device_model,
        e.asset_code,
        e.service_tag,
        e.mac_address,
        e.ip_address,
        e.manufacturer,
        e.cpu,
        e.ram,
        e.hd,
        e.windows_license,
        e.av_license,
        e.department_id AS device_department_id,
        eqd.department_code AS device_department,
        e.location AS device_location,
        e.status AS device_status,
        e.remark AS device_remark,
        -- platform/os_type/os_version moved onto dbo.equipment itself (see
        -- viewColumnModel.js) - read from e, not the old server_usage join.
        e.platform AS server_platform,
        e.os_type AS server_os_type,
        e.os_version AS server_os_version,
        av.antivirus_status,
        av.plan_date AS antivirus_plan_date,
        av.due_date AS antivirus_due_date,
        -- Software licences on this device. Gathered into one row rather than
        -- joined directly, which would repeat the whole device row once per
        -- licence and show duplicates in the table.
        lic.license_names,
        -- Dates only make sense for a single licence; with two, one expiry
        -- cannot stand for both, so they are left null and the names shown.
        CASE WHEN lic.license_count = 1 THEN lic.single_start  END AS license_date_start,
        CASE WHEN lic.license_count = 1 THEN lic.single_expire END AS license_date_expire,
        CASE WHEN lic.license_count = 1 THEN lic.single_status END AS license_status
      FROM dbo.employee emp
      LEFT JOIN dbo.department empd ON emp.department_id = empd.department_id
      LEFT JOIN dbo.equipment e ON e.owner_id = emp.employee_id
      LEFT JOIN dbo.category c ON e.category_id = c.category_id
      LEFT JOIN dbo.department eqd ON e.department_id = eqd.department_id
      LEFT JOIN dbo.server_usage su ON su.equipment_id = e.equipment_id
      LEFT JOIN dbo.antivirus_install av ON av.equipment_id = e.equipment_id
      OUTER APPLY (
        SELECT
          STRING_AGG(sl.product_name, ', ') AS license_names,
          COUNT(*)            AS license_count,
          MIN(sl.date_start)  AS single_start,
          MIN(sl.date_expire) AS single_expire,
          MIN(CASE
                WHEN sl.license_type IN ('Free', 'Perpetual') THEN 'active'
                WHEN sl.date_expire IS NULL THEN 'unknown'
                WHEN sl.date_expire < CAST(GETDATE() AS DATE) THEN 'expired'
                WHEN sl.date_expire <= DATEADD(MONTH, 1, CAST(GETDATE() AS DATE)) THEN 'near expire'
                ELSE 'active'
              END) AS single_status
        FROM dbo.equipment_software_license l
        JOIN dbo.software_license sl ON l.license_id = sl.license_id
        WHERE l.equipment_id = e.equipment_id
      ) lic
      WHERE emp.full_name LIKE :name
      ORDER BY emp.full_name, c.category_name, e.computer_name
    `, { replacements: { name: `%${name}%` }, type: QueryTypes.SELECT });
}

async function findByName(fullName) {
  return Employee.findOne({
    where: { full_name: fullName },
    attributes: ['employee_id', 'full_name', 'department_id', 'location', 'position'],
    raw: true,
  });
}

// The assign page's employee dropdown: active employees, optionally narrowed
// by position/department/search text, each with a live count of what they
// already hold - so an admin can see "already has 3 devices" before handing
// over a 4th. Moved here from assignController.js, which used to run this
// query itself.
async function findForAssign({ position, department, q } = {}) {
  let query = `
    SELECT emp.employee_id,
           emp.full_name,
           emp.position,
           emp.staff_code,
           emp.location,
           emp.department_id,
           d.department_code,
           d.department_name,
           (SELECT COUNT(*) FROM dbo.equipment e WHERE e.owner_id = emp.employee_id)
             AS current_equipment_count
    FROM dbo.employee emp
    LEFT JOIN dbo.department d ON emp.department_id = d.department_id
    WHERE emp.is_active = 1
  `;
  const replacements = {};

  if (position) {
    query += ' AND emp.position = :position';
    replacements.position = position;
  }
  if (department) {
    query += ' AND d.department_code = :department';
    replacements.department = department;
  }
  if (q) {
    query += ' AND (emp.full_name LIKE :q OR emp.staff_code LIKE :q)';
    replacements.q = `%${q}%`;
  }

  query += ' ORDER BY emp.full_name';

  return sequelize.query(query, { replacements, type: QueryTypes.SELECT });
}

// deviceReplacementModel.js already defines DeviceReplacement with both
// old/new Equipment self-joins aliased (oldEquipment/newEquipment) - reused
// here via the same lazy-require reasoning as findAllWithEquipment() above,
// rather than re-declaring the same associations a second time.
async function findReplacementHistory(employeeId) {
  const { DeviceReplacement } = require('./deviceReplacementModel');
  const { Equipment } = require('./equipmentModel');

  const rows = await DeviceReplacement.findAll({
    where: { employee_id: employeeId },
    include: [
      { model: Equipment, as: 'oldEquipment' },
      { model: Equipment, as: 'newEquipment' },
    ],
    order: [['replacement_date', 'ASC']],
  });

  return rows.map((row) => {
    const { oldEquipment: oldEq, newEquipment: newEq, ...dr } = row.get({ plain: true });
    return {
      replacement_id: dr.replacement_id,
      old_device_model: oldEq ? oldEq.device_model : null,
      old_service_tag: oldEq ? oldEq.service_tag : null,
      old_asset_code: oldEq ? oldEq.asset_code : null,
      old_device_status: dr.old_device_status,
      location_of_old: dr.old_device_location,
      old_bag: dr.old_bag,
      old_mouse: dr.old_mouse,
      old_keyboard: dr.old_keyboard,
      new_computer_name: newEq ? newEq.computer_name : null,
      new_device_model: newEq ? newEq.device_model : null,
      new_service_tag: newEq ? newEq.service_tag : null,
      new_product_id: newEq ? newEq.product_id : null,
      new_asset_code: newEq ? newEq.asset_code : null,
      new_bag: dr.new_bag,
      new_mouse: dr.new_mouse,
      new_keyboard: dr.new_keyboard,
      replacement_date: dr.replacement_date,
      new_owner_location: dr.new_owner_location,
    };
  });
}

async function create(data) {
  const row = await Employee.create({
    full_name: data.full_name,
    staff_code: data.staff_code || null,
    phone: data.phone || null,
    sex: data.sex || null,
    department_id: data.department_id || null,
    location: data.location || null,
    position: data.position || null,
  });
  return row.get({ plain: true });
}

// Partial update - COALESCE keeps the existing value when a field isn't
// supplied. A JS undefined and an explicit null both arrive as SQL NULL
// through the old driver, so both are treated as "leave unchanged" here too.
async function update(id, data) {
  const values = {};
  if (data.full_name !== undefined && data.full_name !== null) values.full_name = data.full_name;
  if (data.staff_code !== undefined && data.staff_code !== null) values.staff_code = data.staff_code;
  if (data.phone !== undefined && data.phone !== null) values.phone = data.phone;
  if (data.sex !== undefined && data.sex !== null) values.sex = data.sex;
  if (data.department_id !== undefined && data.department_id !== null) values.department_id = data.department_id;
  if (data.location !== undefined && data.location !== null) values.location = data.location;
  if (data.position !== undefined && data.position !== null) values.position = data.position;
  if (data.is_active !== undefined && data.is_active !== null) values.is_active = data.is_active;
  if (data.left_date !== undefined && data.left_date !== null) values.left_date = data.left_date;

  if (Object.keys(values).length === 0) {
    // Nothing to change - original still ran the UPDATE (every SET a no-op
    // COALESCE) and returned the current row via OUTPUT INSERTED.*.
    const row = await Employee.findByPk(id, { raw: true });
    return row || null;
  }

  const [, rows] = await Employee.update(values, {
    where: { employee_id: id },
    returning: true,
  });
  return rows && rows[0] ? rows[0].get({ plain: true }) : null;
}

// Everything referencing this employee. Delete is refused while any exist -
// removing a person would otherwise orphan their equipment and loan history.
// Same lazy-require reasoning as findAllWithEquipment()/
// findReplacementHistory() above - four independent counts merged in JS
// (not one query joining everything) to avoid fan-out between unrelated
// tables, same as equipmentModel.countReferences()'s own mirror of this.
async function countReferences(id) {
  // A raw `= :id` parameter never matches a NULL column, even one that's
  // also NULL (standard SQL, not a bug) - but Sequelize's plain `{ x: null }`
  // where-shorthand compiles to `x IS NULL`, which DOES match. A handful of
  // real borrow_record rows genuinely have a NULL borrower_id (from a past
  // employee delete via remove() below, which clears it) - short-circuiting
  // here keeps a null/undefined id matching nothing, same as the original.
  if (id === null || id === undefined) {
    return { owned_equipment: 0, borrow_records: 0, items_still_out: 0, server_usage: 0, replacements: 0 };
  }

  const { Equipment } = require('./equipmentModel');
  const { BorrowRecord } = require('./borrowModel');
  const { ServerUsage } = require('./serverUsageModel');
  const { DeviceReplacement } = require('./deviceReplacementModel');

  const [owned_equipment, borrow_records, items_still_out, server_usage, replacements] = await Promise.all([
    Equipment.count({ where: { owner_id: id } }),
    BorrowRecord.count({ where: { [Op.or]: [{ borrower_id: id }, { issued_by_id: id }, { received_by_id: id }] } }),
    BorrowRecord.count({ where: { borrower_id: id, return_date: null } }),
    // server_usage has no owner_id of its own - ownership lives on the
    // equipment row it's for (see serverUsageModel.js). belongsTo, so no
    // fan-out risk counting through the include.
    ServerUsage.count({ include: [{ model: Equipment, as: 'equipment', where: { owner_id: id }, required: true }] }),
    // device_replacement only has employee_id; its issued_by_id and
    // received_by_id columns were dropped as they were never populated.
    DeviceReplacement.count({ where: { employee_id: id } }),
  ]);
  return { owned_equipment, borrow_records, items_still_out, server_usage, replacements };
}

// Captures the row into the recycle bin before removing it, both in one
// transaction - if the delete fails, the bin entry rolls back with it.
// Self-contained now that recycleBinModel.create() itself takes a Sequelize
// transaction.
async function remove(id, fullName, actor) {
  return sequelize.transaction(async (transaction) => {
    const employee = await Employee.findByPk(id, { transaction, raw: true });
    if (!employee) return false;

    // recycleBinModel.create serialises entityData, so pass the object.
    await recycleBinModel.create(
      {
        entityType: 'employee',
        entityId: id,
        entityLabel: employee.full_name,
        entityData: employee,
        actor,
        reason: 'Employee record deleted',
      },
      transaction,
    );

    // Snapshot the name and clear each reference before deletion - three
    // independent updates (one per column) rather than one CASE-per-column
    // statement, since a row can independently match more than one
    // condition (the same person could be both borrower and issuer on one
    // loan) and each update only ever touches its own column regardless.
    // Doing this explicitly avoids SQL Server's multiple-cascade-path
    // restriction.
    const { BorrowRecord } = require('./borrowModel');
    await BorrowRecord.update(
      { borrower_name: fn('COALESCE', col('borrower_name'), fullName), borrower_id: null },
      { where: { borrower_id: id }, transaction },
    );
    await BorrowRecord.update(
      { issued_by_name: fn('COALESCE', col('issued_by_name'), fullName), issued_by_id: null },
      { where: { issued_by_id: id }, transaction },
    );
    await BorrowRecord.update(
      { received_by_name: fn('COALESCE', col('received_by_name'), fullName), received_by_id: null },
      { where: { received_by_id: id }, transaction },
    );

    // Sequelize's destroy() doesn't add an OUTPUT clause unless asked, so
    // the trigger-rejects-OUTPUT-without-INTO problem the old raw DELETE's
    // comment warned about doesn't apply here - verified live.
    const affected = await Employee.destroy({ where: { employee_id: id }, transaction });

    return affected > 0;
  });
}

module.exports = {
  Employee, // exported so equipmentModel.js can build associations against
  // this same table definition rather than defining it twice.
  findAll,
  findAllWithEquipment,
  countReferences,
  remove,
  findById,
  findByName,
  findForAssign,
  searchWithEquipment,
  findReplacementHistory,
  create,
  update,
};
