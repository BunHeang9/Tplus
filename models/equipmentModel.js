const { sql, poolPromise } = require('../config/db');

// Builds the WHERE clause dynamically from whichever filters were supplied.
// Every value goes through .input() so nothing is ever string-concatenated
// into the SQL - that's what keeps this safe from injection.
async function findAll(filters = {}) {
  const { category, unowned, location, department, status, q } = filters;
  const pool = await poolPromise;
  const request = pool.request();

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

  // Accepts either ?category=Laptop (name) or ?category_id=5
  if (category) {
    query += ' AND c.category_name = @category';
    request.input('category', sql.VarChar, category);
  }
  if (filters.category_id) {
    query += ' AND e.category_id = @category_id';
    request.input('category_id', sql.Int, filters.category_id);
  }
  if (unowned === 'true') {
    query += ' AND e.owner_id IS NULL';
  }
  if (location) {
    query += ' AND e.location = @location';
    request.input('location', sql.VarChar, location);
  }
  if (department) {
    query += ' AND d.department_code = @department';
    request.input('department', sql.VarChar, department);
  }
  if (filters.department_id) {
    query += ' AND e.department_id = @department_id';
    request.input('department_id', sql.Int, filters.department_id);
  }
  // Accepts either ?status=Working - IT Stock (name) or ?status_id=2
  if (status) {
    query += ' AND st.status_name = @status';
    request.input('status', sql.VarChar, status);
  }
  if (filters.status_id) {
    query += ' AND e.status_id = @status_id';
    request.input('status_id', sql.Int, filters.status_id);
  }
  if (q) {
    query += ` AND (
      e.computer_name  LIKE @q OR
      e.device_model   LIKE @q OR
      e.equipment_code LIKE @q OR
      e.service_tag    LIKE @q OR
      e.mac_address    LIKE @q OR
      e.ip_address     LIKE @q OR
      e.manufacturer   LIKE @q OR
      emp.full_name    LIKE @q
    )`;
    request.input('q', sql.NVarChar, `%${q}%`);
  }

  query += ' ORDER BY c.category_name, e.equipment_id';

  const result = await request.query(query);
  return result.recordset;
}

async function findById(id) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('id', sql.Int, id)
    .query(`
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
      WHERE e.equipment_id = @id
    `);
  return result.recordset[0] || null;
}

async function getCategorySummary() {
  const pool = await poolPromise;
  const result = await pool.request().query(`
    SELECT c.category_id,
           c.category_name AS category,
           COUNT(e.equipment_id) AS total_items,
           SUM(CASE WHEN e.owner_id IS NULL     THEN 1 ELSE 0 END) AS no_owner,
           SUM(CASE WHEN e.owner_id IS NOT NULL THEN 1 ELSE 0 END) AS has_owner
    FROM dbo.category c
    LEFT JOIN dbo.equipment e ON e.category_id = c.category_id
    GROUP BY c.category_id, c.category_name
    ORDER BY c.category_name
  `);
  return result.recordset;
}

async function updateOwner(id, ownerId) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('id', sql.Int, id)
    .input('owner_id', sql.Int, ownerId || null)
    .query(`
      UPDATE dbo.equipment
      SET owner_id = @owner_id
      OUTPUT INSERTED.*
      WHERE equipment_id = @id
    `);
  return result.recordset[0] || null;
}

// --- Stock workflow ---

async function findByEquipmentCode(code) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('code', sql.VarChar, code)
    .query('SELECT equipment_id, computer_name, device_model FROM dbo.equipment WHERE equipment_code = @code');
  return result.recordset[0] || null;
}

async function findByServiceTag(tag) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('tag', sql.VarChar, tag)
    .query('SELECT equipment_id, computer_name FROM dbo.equipment WHERE service_tag = @tag');
  return result.recordset[0] || null;
}

// New stock always starts with owner_id NULL - assignment is a separate step.
async function createStock(d) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input("category_id", sql.Int, d.category_id)
    .input("device_type", sql.VarChar, d.device_type || null)
    .input("device_model", sql.VarChar, d.device_model || null)
    .input("manufacturer", sql.VarChar, d.manufacturer || null)
    .input("equipment_code", sql.VarChar, d.equipment_code || null)
    .input("service_tag", sql.VarChar, d.service_tag || null)
    .input("serial_no", sql.VarChar, d.serial_no || null)
    .input("product_id", sql.VarChar, d.product_id || null)
    .input("mac_address", sql.VarChar, d.mac_address || null)
    .input("ip_address", sql.VarChar, d.ip_address || null)
    .input("os_type", sql.VarChar, d.os_type || null)
    .input("os_version", sql.VarChar, d.os_version || null)
    .input("cpu", sql.NVarChar, d.cpu || null)
    .input("ram", sql.NVarChar, d.ram || null)
    .input("hd", sql.NVarChar, d.hd || null)
    .input("windows_license", sql.NVarChar, d.windows_license || null)
    .input("av_license", sql.NVarChar, d.av_license || null)
    .input("purchase_date", sql.Date, d.purchase_date || null)
    .input("received_date", sql.Date, d.received_date || null)
    .input("location", sql.VarChar, d.location || null)
    .input("department_id", sql.Int, d.department_id || null)
    .input("status", sql.VarChar, d.status || "Working - IT Stock")
    .input("remark", sql.VarChar, d.remark || null).query(`
      INSERT INTO dbo.equipment (
        category_id, device_type, device_model, manufacturer,
        equipment_code, service_tag, serial_no, product_id,
        mac_address, ip_address, os_type, os_version,
        cpu, ram, hd, windows_license, av_license,
        purchase_date, received_date,
        location, department_id, status, status_id, remark, owner_id
      )
      OUTPUT INSERTED.*
      VALUES (
        @category_id, @device_type, @device_model, @manufacturer,
        @equipment_code, @service_tag, @serial_no, @product_id,
        @mac_address, @ip_address, @os_type, @os_version,
        @cpu, @ram, @hd, @windows_license, @av_license,
        @purchase_date, @received_date,
        @location, @department_id, @status,
        (SELECT status_id FROM dbo.equipment_status WHERE status_name = @status),
        @remark, NULL
      )
    `);
  return result.recordset[0];
}

async function findWithOwnerName(id) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('id', sql.Int, id)
    .query(`
      SELECT e.equipment_id, e.owner_id, e.computer_name, e.device_model,
             emp.full_name AS current_owner
      FROM dbo.equipment e
      LEFT JOIN dbo.employee emp ON e.owner_id = emp.employee_id
      WHERE e.equipment_id = @id
    `);
  return result.recordset[0] || null;
}

async function assign(id, d) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('id', sql.Int, id)
    .input('owner_id', sql.Int, d.owner_id)
    .input('assigned_date', sql.Date, d.assigned_date || null)
    .input('computer_name', sql.NVarChar, d.computer_name || null)
    .input('ip_address', sql.VarChar, d.ip_address || null)
    .input('location', sql.VarChar, d.location || null)
    .input('department_id', sql.Int, d.department_id || null)
    .input('status', sql.VarChar, d.status || null)
    .query(`
      UPDATE dbo.equipment
      SET owner_id      = @owner_id,
          assigned_date = COALESCE(@assigned_date, assigned_date),
          computer_name = COALESCE(@computer_name, computer_name),
          ip_address    = COALESCE(@ip_address, ip_address),
          location      = COALESCE(@location, location),
          department_id = COALESCE(@department_id, department_id),
          status        = COALESCE(@status, status),
          status_id     = COALESCE(
                              (SELECT status_id FROM dbo.equipment_status WHERE status_name = @status),
                              status_id)
      OUTPUT INSERTED.*
      WHERE equipment_id = @id
    `);
  return result.recordset[0] || null;
}
//Unassign
// name=models/equipmentModel.js
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
  const pool = await poolPromise;
  const request = pool.request();
  let query = `
    SELECT e.equipment_id, e.category_id, c.category_name AS category,
           e.device_type, e.computer_name, e.device_model,
           e.manufacturer, e.equipment_code, e.service_tag, e.mac_address, e.ip_address,
           e.cpu, e.ram, e.hd, e.purchase_date, e.received_date,
           e.location, e.department_id, d.department_code AS department,
           e.status, e.remark
    FROM dbo.equipment e
    LEFT JOIN dbo.category c ON e.category_id = c.category_id
    LEFT JOIN dbo.department d ON e.department_id = d.department_id
    LEFT JOIN dbo.equipment_status st ON e.status_id = st.status_id
    WHERE e.owner_id IS NULL
  `;

  // Driven by the is_assignable flag on dbo.equipment_status rather than a
  // hardcoded list, so changing the rule is a data change, not a code change.
  // ?include_installed=true is an escape hatch for assigning an installed
  // device to someone as its custodian.
  if (includeInstalled !== 'true') {
    query += ' AND st.is_assignable = 1';
  }
  if (category) {
    query += ' AND c.category_name = @category';
    request.input('category', sql.VarChar, category);
  }
  query += ' ORDER BY e.received_date DESC, e.equipment_id DESC';

  const result = await request.query(query);
  return result.recordset;
}

// Falls back to purchase_date where received_date was never recorded.
async function findByDateRange(from, to) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('from', sql.Date, from)
    .input('to', sql.Date, to)
    .query(`
      SELECT e.equipment_id, e.category_id, c.category_name AS category,
             e.device_type, e.computer_name, e.device_model,
             e.manufacturer, e.equipment_code, e.service_tag,
             e.purchase_date, e.received_date, e.assigned_date,
             e.location, e.status,
             emp.full_name AS owner_name,
             emp.position  AS owner_position,
             empd.department_code AS owner_department
      FROM dbo.equipment e
      LEFT JOIN dbo.category c ON e.category_id = c.category_id
      LEFT JOIN dbo.employee emp ON e.owner_id = emp.employee_id
      LEFT JOIN dbo.department empd ON emp.department_id = empd.department_id
      WHERE COALESCE(e.received_date, e.purchase_date) BETWEEN @from AND @to
      ORDER BY COALESCE(e.received_date, e.purchase_date), e.equipment_id
    `);
  return result.recordset;
}

// Full detail update. COALESCE means only the fields actually supplied
// change - omitting a field leaves it alone rather than nulling it.
async function update(id, d) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('id', sql.Int, id)
    .input('category_id', sql.Int, d.category_id)
    .input('device_type', sql.VarChar, d.device_type)
    .input('device_model', sql.VarChar, d.device_model)
    .input('computer_name', sql.NVarChar, d.computer_name)
    .input('manufacturer', sql.VarChar, d.manufacturer)
    .input('serial_no', sql.VarChar, d.serial_no)
    .input('service_tag', sql.VarChar, d.service_tag)
    .input('product_id', sql.VarChar, d.product_id)
    .input('equipment_code', sql.VarChar, d.equipment_code)
    .input('mac_address', sql.VarChar, d.mac_address)
    .input('ip_address', sql.VarChar, d.ip_address)
    .input('os_type', sql.VarChar, d.os_type)
    .input('os_version', sql.VarChar, d.os_version)
    .input('cpu', sql.NVarChar, d.cpu)
    .input('ram', sql.NVarChar, d.ram)
    .input('hd', sql.NVarChar, d.hd)
    .input('windows_license', sql.NVarChar, d.windows_license)
    .input('av_license', sql.NVarChar, d.av_license)
    .input('location', sql.VarChar, d.location)
    .input('department_id', sql.Int, d.department_id)
    .input('status', sql.VarChar, d.status)
    .input('purchase_date', sql.Date, d.purchase_date)
    .input('received_date', sql.Date, d.received_date)
    .input('assigned_date', sql.Date, d.assigned_date)
    .input('remark', sql.VarChar, d.remark)
    .query(`
      UPDATE dbo.equipment
      SET category_id     = COALESCE(@category_id, category_id),
          device_type     = COALESCE(@device_type, device_type),
          device_model    = COALESCE(@device_model, device_model),
          computer_name   = COALESCE(@computer_name, computer_name),
          manufacturer    = COALESCE(@manufacturer, manufacturer),
          serial_no       = COALESCE(@serial_no, serial_no),
          service_tag     = COALESCE(@service_tag, service_tag),
          product_id      = COALESCE(@product_id, product_id),
          equipment_code  = COALESCE(@equipment_code, equipment_code),
          mac_address     = COALESCE(@mac_address, mac_address),
          ip_address      = COALESCE(@ip_address, ip_address),
          os_type         = COALESCE(@os_type, os_type),
          os_version      = COALESCE(@os_version, os_version),
          cpu             = COALESCE(@cpu, cpu),
          ram             = COALESCE(@ram, ram),
          hd              = COALESCE(@hd, hd),
          windows_license = COALESCE(@windows_license, windows_license),
          av_license      = COALESCE(@av_license, av_license),
          location        = COALESCE(@location, location),
          department_id   = COALESCE(@department_id, department_id),
          status          = COALESCE(@status, status),
          status_id       = COALESCE(
                                (SELECT status_id FROM dbo.equipment_status WHERE status_name = @status),
                                status_id),
          purchase_date   = COALESCE(@purchase_date, purchase_date),
          received_date   = COALESCE(@received_date, received_date),
          assigned_date   = COALESCE(@assigned_date, assigned_date),
          remark          = COALESCE(@remark, remark)
      OUTPUT INSERTED.*
      WHERE equipment_id = @id
    `);
  return result.recordset[0] || null;
}

// Counts everything pointing at this equipment. Delete is refused while any
// of these exist, otherwise we would orphan borrow history, antivirus records
// and replacement history.
async function countReferences(id) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('id', sql.Int, id)
    .query(`
      SELECT
        (SELECT COUNT(*) FROM dbo.borrow_record      WHERE equipment_id = @id) AS borrow_records,
        (SELECT COUNT(*) FROM dbo.antivirus_install  WHERE equipment_id = @id) AS antivirus_records,
        (SELECT COUNT(*) FROM dbo.server_usage       WHERE equipment_id = @id) AS server_usage_records,
        (SELECT COUNT(*) FROM dbo.ssd_upgrade        WHERE equipment_id = @id) AS ssd_upgrade_records,
        (SELECT COUNT(*) FROM dbo.device_replacement WHERE old_equipment_id = @id
                                                        OR new_equipment_id = @id) AS replacement_records
    `);
  return result.recordset[0];
}

// Captures the row into the recycle bin before removing it, both in one
// transaction - so a failed delete cannot leave an orphaned bin entry, and a
// failed bin write cannot lose the equipment.
//
// Custom field values go into the snapshot too, otherwise restoring would
// bring back the device without whatever an admin had recorded against it.
async function remove(id, actor) {
  const recycleBinModel = require('./recycleBinModel');
  const customFieldModel = require('./customFieldModel');

  const pool = await poolPromise;
  const transaction = new sql.Transaction(pool);
  await transaction.begin();

  try {
    const row = await new sql.Request(transaction)
      .input("id", sql.Int, id)
      .query("SELECT * FROM dbo.equipment WHERE equipment_id = @id");

    const equipment = row.recordset[0];
    if (!equipment) {
      await transaction.rollback();
      return null;
    }

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
        entityType: "equipment",
        entityId: id,
        entityLabel: label,
        entityData: { ...equipment, _custom_values: customValues },
        actor,
        reason: "Equipment deleted",
      },
      transaction,
    );

    await new sql.Request(transaction)
      .input("id", sql.Int, id)
      .query("DELETE FROM dbo.equipment WHERE equipment_id = @id");

    await transaction.commit();
    return equipment;
  } catch (err) {
    try {
      await transaction.rollback();
    } catch {
      /* already rolled back */
    }
    throw err;
  }
}

module.exports = {
  findAll,
  update,
  countReferences,
  remove,
  findById,
  getCategorySummary,
  updateOwner,
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