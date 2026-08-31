const { DataTypes, fn, col } = require('sequelize');
const sequelize = require('../config/sequelize');

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

// employee_count/equipment_count come from two other tables, which would
// normally mean Department needs Employee/Equipment associations - but
// equipmentModel.js/employeeModel.js already import Department from this
// file at their own top level (to build their own belongsTo), so this file
// requiring either of them back at ITS top level would be a real require
// cycle. The fix isn't "stay raw forever" though: both requires below are
// lazy (inside the function body, evaluated only when the function actually
// runs) - by the time any request handler calls findAll(), the whole app
// has already finished starting up and every model file has already loaded
// once, so the require just returns the cached, fully-built module. Same
// technique already used by customFieldModel.js/partModel.js for the same
// kind of cycle.
//
// Two separate GROUP BY aggregates merged in JS, not one query joining both
// Employee and Equipment at once - joining both together on the same
// department would fan out (a department with 3 employees and 5 equipment
// becomes 15 joined rows before any COUNT), corrupting both counts.
async function findAll() {
  const { Employee } = require('./employeeModel');
  const { Equipment } = require('./equipmentModel');

  const [employeeCounts, equipmentCounts, departments] = await Promise.all([
    Employee.findAll({
      attributes: ['department_id', [fn('COUNT', col('employee_id')), 'n']],
      group: ['department_id'],
      raw: true,
    }),
    Equipment.findAll({
      attributes: ['department_id', [fn('COUNT', col('equipment_id')), 'n']],
      group: ['department_id'],
      raw: true,
    }),
    Department.findAll({ order: [['department_code', 'ASC']], raw: true }),
  ]);

  const employeeCountByDept = new Map(employeeCounts.map((r) => [r.department_id, r.n]));
  const equipmentCountByDept = new Map(equipmentCounts.map((r) => [r.department_id, r.n]));

  return departments.map((d) => ({
    department_id: d.department_id,
    department_code: d.department_code,
    department_name: d.department_name,
    is_active: d.is_active,
    employee_count: employeeCountByDept.get(d.department_id) || 0,
    equipment_count: equipmentCountByDept.get(d.department_id) || 0,
  }));
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
// Same lazy-require reasoning as findAll() above.
async function countUsage(id) {
  const { Employee } = require('./employeeModel');
  const { Equipment } = require('./equipmentModel');

  const [employee_count, equipment_count] = await Promise.all([
    Employee.count({ where: { department_id: id } }),
    Equipment.count({ where: { department_id: id } }),
  ]);
  return { employee_count, equipment_count };
}

// Captures the row into the recycle bin before removing it, both in one
// transaction - so a failed delete can never leave an orphaned bin entry, and
// a failed bin write can never lose the department. Self-contained now that
// recycleBinModel.create() itself takes a Sequelize transaction.
async function remove(id, actor) {
  const recycleBinModel = require('./recycleBinModel');

  return sequelize.transaction(async (transaction) => {
    const row = await Department.findByPk(id, { transaction, raw: true });
    if (!row) return null;

    await recycleBinModel.create(
      {
        entityType: 'department',
        entityId: id,
        entityLabel: row.department_name || row.department_code,
        entityData: row,
        actor,
        reason: 'Department deleted',
      },
      transaction,
    );

    await Department.destroy({ where: { department_id: id }, transaction });

    return row;
  });
}

module.exports = {
  Department, // exported so equipmentModel.js can build associations against
  // this same table definition rather than defining it twice.
  findAll, findById, findByCode, create, update, countUsage, remove,
};
