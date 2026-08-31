const { DataTypes } = require('sequelize');
const sequelize = require('../config/sequelize');
const { QueryTypes } = require('sequelize');

// Reference table: dbo.department
// Departments used to be free text on employee/equipment; they now live
// here and are linked by department_id.

const Department = sequelize.define('Department', {
  department_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  department_code: { type: DataTypes.STRING(50), allowNull: false },
  department_name: { type: DataTypes.STRING(100), allowNull: true },
  is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  // Has its own DB-side default (legacy DATETIME) - let the DB fill it in,
  // same reasoning as categoryModel/auditLogModel/apiUserModel.
  created_at: { type: DataTypes.DATE, allowNull: true },
}, {
  tableName: 'department',
  schema: 'dbo',
  timestamps: false,
});

// Two correlated subqueries (employee_count, equipment_count) - reporting
// read, raw query through Sequelize rather than .findAll().
async function findAll() {
  return sequelize.query(`
    SELECT d.department_id, d.department_code, d.department_name, d.is_active,
           (SELECT COUNT(*) FROM dbo.employee  e WHERE e.department_id = d.department_id) AS employee_count,
           (SELECT COUNT(*) FROM dbo.equipment q WHERE q.department_id = d.department_id) AS equipment_count
    FROM dbo.department d
    ORDER BY d.department_code
  `, { type: QueryTypes.SELECT });
}

async function findById(id) {
  return Department.findByPk(id, { raw: true });
}

async function findByCode(code) {
  return Department.findOne({ where: { department_code: code }, raw: true });
}

async function create({ department_code, department_name }) {
  const row = await Department.create({
    department_code,
    department_name: department_name || department_code,
  });
  return row.get({ plain: true });
}

async function update(id, { department_code, department_name, is_active }) {
  const values = {};
  if (department_code !== undefined && department_code !== null) values.department_code = department_code;
  if (department_name !== undefined && department_name !== null) values.department_name = department_name;
  if (is_active !== undefined && is_active !== null) values.is_active = is_active;

  if (Object.keys(values).length === 0) return findById(id);

  const [, [row]] = await Department.update(values, {
    where: { department_id: id },
    returning: true,
  });
  return row ? row.get({ plain: true }) : null;
}

// Refuses to delete a department that is still referenced, so we never
// leave employees or equipment pointing at a row that no longer exists.
async function countUsage(id) {
  const [row] = await sequelize.query(`
    SELECT
      (SELECT COUNT(*) FROM dbo.employee  WHERE department_id = :id) AS employee_count,
      (SELECT COUNT(*) FROM dbo.equipment WHERE department_id = :id) AS equipment_count
  `, { replacements: { id }, type: QueryTypes.SELECT });
  return row;
}

// Captures the row into the recycle bin before removing it, both in one
// transaction - so a failed delete can never leave an orphaned bin entry, and
// a failed bin write can never lose the department. Self-contained now that
// recycleBinModel.create() itself takes a Sequelize transaction.
async function remove(id, actor) {
  const recycleBinModel = require('./recycleBinModel');

  return sequelize.transaction(async (transaction) => {
    const [department] = await sequelize.query(
      'SELECT * FROM dbo.department WHERE department_id = :id',
      { replacements: { id }, type: QueryTypes.SELECT, transaction },
    );
    if (!department) return null;

    await recycleBinModel.create(
      {
        entityType: 'department',
        entityId: id,
        entityLabel: department.department_name || department.department_code,
        entityData: department,
        actor,
        reason: 'Department deleted',
      },
      transaction,
    );

    await sequelize.query(
      'DELETE FROM dbo.department WHERE department_id = :id',
      { replacements: { id }, transaction },
    );

    return department;
  });
}

module.exports = {
  Department, // exported so equipmentModel.js can build associations against
  // this same table definition rather than defining it twice.
  findAll, findById, findByCode, create, update, countUsage, remove,
};
