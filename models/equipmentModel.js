const { sql } = require('../config/db');
const sequelize = require('../config/sequelize');
const { QueryTypes } = require('sequelize');

// Raw queries with no model attribute definition return a plain string for a
// DATE column; the driver this replaces returned a Date object for the same
// column. Converting back keeps every response identical to before this
// migration. borrowed_on/due_back are the OUTER APPLY's borrow_date/
// expected_return_date, same underlying DATE type.
const DATE_FIELDS = ['purchase_date', 'received_date', 'assigned_date', 'borrowed_on', 'due_back'];
function fixDates(row) {
  if (!row) return row;
  for (const f of DATE_FIELDS) {
    if (row[f]) row[f] = new Date(row[f]);
  }
  return row;
}

// Builds the WHERE clause dynamically from whichever filters were supplied.
// Every value goes through a named replacement so nothing is ever string-
// concatenated into the SQL - that's what keeps this safe from injection.
async function findAll(filters = {}) {
  const { category, unowned, location, department, status, q } = filters;

  let query = `
    SELECT e.*,
           c.category_name,
           d.department_code,
           d.department_name,
           st.status_name,
           st.is_assignable,
           st.is_borrowable,
           emp.full_name  AS owner_name,
           emp.position   AS owner_position,
           emp.location   AS owner_location,
           emp.staff_code AS owner_staff_code,
           emp.sex        AS owner_sex,
           empd.department_code AS owner_department,
           empd.department_name AS owner_department_name,
           loan.borrow_id            AS current_borrow_id,
           br.full_name              AS current_borrower,
           loan.borrow_date          AS borrowed_on,
           loan.expected_return_date AS due_back
    FROM dbo.equipment e
    LEFT JOIN dbo.category c ON e.category_id = c.category_id
    LEFT JOIN dbo.department d ON e.department_id = d.department_id
    LEFT JOIN dbo.equipment_status st ON e.status_id = st.status_id
    LEFT JOIN dbo.employee emp ON e.owner_id = emp.employee_id
    LEFT JOIN dbo.department empd ON emp.department_id = empd.department_id
    OUTER APPLY (
      SELECT TOP 1 b.borrow_id, b.borrow_date, b.expected_return_date, b.borrower_id
      FROM dbo.borrow_record b
      WHERE b.equipment_id = e.equipment_id AND b.return_date IS NULL
      ORDER BY b.borrow_date DESC
    ) AS loan
    LEFT JOIN dbo.employee br ON loan.borrower_id = br.employee_id
    WHERE 1=1
  `;
  const replacements = {};

  // Accepts either ?category=Laptop (name) or ?category_id=5
  if (category) {
    query += ' AND c.category_name = :category';
    replacements.category = category;
  }
  if (filters.category_id) {
    query += ' AND e.category_id = :category_id';
    replacements.category_id = filters.category_id;
  }
  if (unowned === 'true') {
    query += ' AND e.owner_id IS NULL';
  }
  if (location) {
    query += ' AND e.location = :location';
    replacements.location = location;
  }
  if (department) {
    query += ' AND d.department_code = :department';
    replacements.department = department;
  }
  if (filters.department_id) {
    query += ' AND e.department_id = :department_id';
    replacements.department_id = filters.department_id;
  }
  // Accepts either ?status=Working - IT Stock (name) or ?status_id=2
  if (status) {
    query += ' AND st.status_name = :status';
    replacements.status = status;
  }
  if (filters.status_id) {
    query += ' AND e.status_id = :status_id';
    replacements.status_id = filters.status_id;
  }
  if (q) {
    // device_name and serial_no matter as much as computer_name/service_tag -
    // a server row typically has device_name set and computer_name null, the
    // opposite of a laptop, so leaving either out silently misses whichever
    // category relies on it.
    query += ` AND (
      e.computer_name  LIKE :q OR
      e.device_name    LIKE :q OR
      e.device_model   LIKE :q OR
      e.asset_code LIKE :q OR
      e.serial_no      LIKE :q OR
      e.service_tag    LIKE :q OR
      e.mac_address    LIKE :q OR
      e.ip_address     LIKE :q OR
      e.manufacturer   LIKE :q OR
      emp.full_name    LIKE :q
    )`;
    replacements.q = `%${q}%`;
  }

  query += ' ORDER BY c.category_name, e.equipment_id';

  const rows = await sequelize.query(query, { replacements, type: QueryTypes.SELECT });
  return rows.map(fixDates);
}

async function findById(id) {
  const rows = await sequelize.query(`
      SELECT e.*,
             c.category_name,
             d.department_code,
             d.department_name,
             st.status_name,
             st.is_assignable,
             st.is_borrowable,
             emp.full_name  AS owner_name,
             emp.position   AS owner_position,
             emp.location   AS owner_location,
             emp.staff_code AS owner_staff_code,
             emp.sex        AS owner_sex,
             empd.department_code AS owner_department,
             empd.department_name AS owner_department_name,
             loan.borrow_id            AS current_borrow_id,
             br.full_name              AS current_borrower,
             loan.borrow_date          AS borrowed_on,
             loan.expected_return_date AS due_back
      FROM dbo.equipment e
      LEFT JOIN dbo.category c ON e.category_id = c.category_id
      LEFT JOIN dbo.department d ON e.department_id = d.department_id
      LEFT JOIN dbo.equipment_status st ON e.status_id = st.status_id
      LEFT JOIN dbo.employee emp ON e.owner_id = emp.employee_id
      LEFT JOIN dbo.department empd ON emp.department_id = empd.department_id
      OUTER APPLY (
        SELECT TOP 1 b.borrow_id, b.borrow_date, b.expected_return_date, b.borrower_id
        FROM dbo.borrow_record b
        WHERE b.equipment_id = e.equipment_id AND b.return_date IS NULL
        ORDER BY b.borrow_date DESC
      ) AS loan
      LEFT JOIN dbo.employee br ON loan.borrower_id = br.employee_id
      WHERE e.equipment_id = :id
    `, { replacements: { id }, type: QueryTypes.SELECT });
  return fixDates(rows[0]) || null;
}

async function getCategorySummary() {
  return sequelize.query(`
    SELECT c.category_id,
           c.category_name AS category,
           COUNT(e.equipment_id) AS total_items,
           SUM(CASE WHEN e.owner_id IS NULL     THEN 1 ELSE 0 END) AS no_owner,
           SUM(CASE WHEN e.owner_id IS NOT NULL THEN 1 ELSE 0 END) AS has_owner
    FROM dbo.category c
    LEFT JOIN dbo.equipment e ON e.category_id = c.category_id
    GROUP BY c.category_id, c.category_name
    ORDER BY c.category_name
  `, { type: QueryTypes.SELECT });
}

async function updateOwner(id, ownerId) {
  const [row] = await sequelize.query(`
      UPDATE dbo.equipment
      SET owner_id = :owner_id
      OUTPUT INSERTED.*
      WHERE equipment_id = :id
    `, { replacements: { id, owner_id: ownerId || null }, type: QueryTypes.SELECT });
  return fixDates(row) || null;
}

// --- Stock workflow ---

async function findByEquipmentCode(code) {
  const rows = await sequelize.query(
    'SELECT equipment_id, computer_name, device_model FROM dbo.equipment WHERE asset_code = :code',
    { replacements: { code }, type: QueryTypes.SELECT },
  );
  return rows[0] || null;
}

async function findByServiceTag(tag) {
  const rows = await sequelize.query(
    'SELECT equipment_id, computer_name FROM dbo.equipment WHERE service_tag = :tag',
    { replacements: { tag }, type: QueryTypes.SELECT },
  );
  return rows[0] || null;
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
  const rows = await sequelize.query(`
      SELECT e.*, c.category_name, st.status_name
      FROM dbo.equipment e
      LEFT JOIN dbo.category c ON e.category_id = c.category_id
      LEFT JOIN dbo.equipment_status st ON e.status_id = st.status_id
      WHERE e.owner_id = :owner_id
      ORDER BY c.category_name, e.equipment_id
    `, { replacements: { owner_id: ownerId }, type: QueryTypes.SELECT });
  return rows.map(fixDates);
}

async function findWithOwnerName(id) {
  const rows = await sequelize.query(`
      SELECT e.equipment_id, e.owner_id, e.computer_name, e.device_model,
             emp.full_name AS current_owner
      FROM dbo.equipment e
      LEFT JOIN dbo.employee emp ON e.owner_id = emp.employee_id
      WHERE e.equipment_id = :id
    `, { replacements: { id }, type: QueryTypes.SELECT });
  return rows[0] || null;
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
// Still raw mssql, not Sequelize: these three take an external request built
// from equipmentController.js's own sql.Transaction (a single transaction
// covering "one, several, or all-by-owner" in one call), and the controller
// reads back result.recordset directly - the raw mssql result shape.
async function unassignById(
  request,
  equipmentId,
  status = "Working - IT Stock",
) {
  request.input("id", sql.Int, equipmentId);
  request.input("status", sql.VarChar, status);

  return request.query(`
    UPDATE dbo.equipment
    SET owner_id = NULL,
        status = @status,
        status_id = (
          SELECT status_id
          FROM dbo.equipment_status
          WHERE status_name = @status
        )
    OUTPUT INSERTED.*
    WHERE equipment_id = @id
  `);
}

async function unassignByIds(
  request,
  equipmentIds,
  status = "Working - IT Stock",
) {
  equipmentIds.forEach((id, index) => {
    request.input(`id${index}`, sql.Int, id);
  });

  const placeholders = equipmentIds.map((_, index) => `@id${index}`).join(", ");

  request.input("status", sql.VarChar, status);

  return request.query(`
    UPDATE dbo.equipment
    SET owner_id = NULL,
        status = @status,
        status_id = (
          SELECT status_id
          FROM dbo.equipment_status
          WHERE status_name = @status
        )
    OUTPUT INSERTED.*
    WHERE equipment_id IN (${placeholders})
  `);
}

async function unassignByOwnerId(
  request,
  ownerId,
  status = "Working - IT Stock",
) {
  request.input("owner_id", sql.Int, ownerId);
  request.input("status", sql.VarChar, status);

  return request.query(`
    UPDATE dbo.equipment
    SET owner_id = NULL,
        status = @status,
        status_id = (
          SELECT status_id
          FROM dbo.equipment_status
          WHERE status_name = @status
        )
    OUTPUT INSERTED.*
    WHERE owner_id = @owner_id
  `);
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
        (SELECT COUNT(*) FROM dbo.ssd_upgrade        WHERE equipment_id = :id) AS ssd_upgrade_records,
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
  unassignById,
  unassignByIds,
  unassignByOwnerId,
  findAvailable,
  findByDateRange,
};
