const { sql, poolPromise } = require('../config/db');

// Equipment statuses (dbo.equipment_status).
//
// These are not just labels - is_assignable and is_borrowable drive what the
// stock and borrow features allow. Changing those flags changes behaviour, so
// they are worth understanding before editing a status.

async function findAll(includeInactive = false) {
  const pool = await poolPromise;
  let query = `
    SELECT s.status_id, s.status_name, s.description,
           s.has_owner, s.is_assignable, s.is_borrowable,
           s.sort_order, s.is_active,
           (SELECT COUNT(*) FROM dbo.equipment e WHERE e.status_id = s.status_id) AS equipment_count
    FROM dbo.equipment_status s
  `;
  if (!includeInactive) query += " WHERE s.is_active = 1";
  query += " ORDER BY s.sort_order, s.status_id";

  const result = await pool.request().query(query);
  return result.recordset;
}

async function findById(id) {
  const pool = await poolPromise;
  const result = await pool.request().input("id", sql.Int, id).query(`
      SELECT s.*,
             (SELECT COUNT(*) FROM dbo.equipment e WHERE e.status_id = s.status_id) AS equipment_count
      FROM dbo.equipment_status s WHERE s.status_id = @id
    `);
  return result.recordset[0] || null;
}

async function findByName(name) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input('name', sql.VarChar, name)
    .query('SELECT * FROM dbo.equipment_status WHERE status_name = @name');
  return result.recordset[0] || null;
}

async function create(d) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input("status_name", sql.VarChar, d.status_name)
    .input("description", sql.NVarChar, d.description || null)
    .input("has_owner", sql.Bit, d.has_owner ? 1 : 0)
    .input("is_assignable", sql.Bit, d.is_assignable ? 1 : 0)
    .input("is_borrowable", sql.Bit, d.is_borrowable ? 1 : 0)
    .input("sort_order", sql.Int, d.sort_order ?? 99).query(`
      INSERT INTO dbo.equipment_status
        (status_name, description, has_owner, is_assignable, is_borrowable, sort_order)
      OUTPUT INSERTED.*
      VALUES (@status_name, @description, @has_owner, @is_assignable, @is_borrowable, @sort_order)
    `);
  return result.recordset[0];
}

// Renaming a status has to update dbo.equipment too - that table keeps a text
// copy of the name alongside status_id, and leaving it stale would make the
// two disagree. Both happen in one transaction.
async function update(id, d) {
  const pool = await poolPromise;
  const transaction = new sql.Transaction(pool);
  await transaction.begin();

  try {
    const before = await new sql.Request(transaction)
      .input("id", sql.Int, id)
      .query(
        "SELECT status_name FROM dbo.equipment_status WHERE status_id = @id",
      );

    const oldName = before.recordset[0]?.status_name;
    if (!oldName) {
      await transaction.rollback();
      return null;
    }

    const updated = await new sql.Request(transaction)
      .input("id", sql.Int, id)
      .input("status_name", sql.VarChar, d.status_name)
      .input("description", sql.NVarChar, d.description)
      .input(
        "has_owner",
        sql.Bit,
        d.has_owner === undefined ? null : d.has_owner ? 1 : 0,
      )
      .input(
        "is_assignable",
        sql.Bit,
        d.is_assignable === undefined ? null : d.is_assignable ? 1 : 0,
      )
      .input(
        "is_borrowable",
        sql.Bit,
        d.is_borrowable === undefined ? null : d.is_borrowable ? 1 : 0,
      )
      .input("sort_order", sql.Int, d.sort_order)
      .input(
        "is_active",
        sql.Bit,
        d.is_active === undefined ? null : d.is_active ? 1 : 0,
      ).query(`
        UPDATE dbo.equipment_status
        SET status_name   = COALESCE(@status_name, status_name),
            description   = COALESCE(@description, description),
            has_owner     = COALESCE(@has_owner, has_owner),
            is_assignable = COALESCE(@is_assignable, is_assignable),
            is_borrowable = COALESCE(@is_borrowable, is_borrowable),
            sort_order    = COALESCE(@sort_order, sort_order),
            is_active     = COALESCE(@is_active, is_active)
        OUTPUT INSERTED.*
        WHERE status_id = @id
      `);

    const row = updated.recordset[0];

    if (d.status_name && d.status_name !== oldName) {
      await new sql.Request(transaction)
        .input("id", sql.Int, id)
        .input("new_name", sql.VarChar, d.status_name)
        .query(
          "UPDATE dbo.equipment SET status = @new_name WHERE status_id = @id",
        );
    }

    await transaction.commit();
    return row;
  } catch (err) {
    try {
      await transaction.rollback();
    } catch {
      /* already rolled back */
    }
    throw err;
  }
}

async function countUsage(id) {
  const pool = await poolPromise;
  const result = await pool.request().input("id", sql.Int, id).query(`
      SELECT COUNT(*) AS equipment_count
      FROM dbo.equipment WHERE status_id = @id
    `);
  return result.recordset[0].equipment_count;
}

async function remove(id) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input("id", sql.Int, id)
    .query(
      "DELETE FROM dbo.equipment_status OUTPUT DELETED.* WHERE status_id = @id",
    );
  return result.recordset[0] || null;
}

module.exports = {
  findAll,
  findById,
  findByName,
  create,
  update,
  countUsage,
  remove,
};