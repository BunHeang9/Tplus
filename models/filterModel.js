const { Op, fn, col, where: sequelizeWhere } = require('sequelize');
const sequelize = require('../config/sequelize');
const { QueryTypes } = require('sequelize');
const { Category } = require('./categoryModel');
const { Department } = require('./departmentModel');
const { EquipmentStatus } = require('./statusModel');
const { Employee } = require('./employeeModel');
const { Equipment } = require('./equipmentModel');

// Distinct values for building dropdown filters on the frontend, read live
// from the data so new values appear automatically.

// A plain DISTINCT-one-column lookup, expressed as a GROUP BY - Sequelize
// has no dedicated "DISTINCT single column" shortcut, and GROUP BY on that
// one column is the standard way to get the same result through the ORM.
async function distinctColumn(Model, columnName) {
  const rows = await Model.findAll({
    attributes: [columnName],
    where: { [columnName]: { [Op.ne]: null } },
    group: [columnName],
    order: [[columnName, 'ASC']],
    raw: true,
  });
  return rows.map((r) => r[columnName]);
}

async function getAllFilterOptions() {
  const [categories, deviceTypes, locations, departments, statuses,
         manufacturers, empDepartments, empLocations, empPositions] = await Promise.all([
    Category.findAll({
      attributes: ['category_id', 'category_name'],
      where: { is_active: true },
      order: [['category_name', 'ASC']],
      raw: true,
    }),
    distinctColumn(Equipment, 'device_type'),
    distinctColumn(Equipment, 'location'),
    Department.findAll({
      attributes: ['department_id', 'department_code', 'department_name'],
      where: { is_active: true },
      order: [['department_code', 'ASC']],
      raw: true,
    }),
    // From the reference table, so every valid option appears in the
    // dropdown even when no equipment currently has that status.
    EquipmentStatus.findAll({
      attributes: ['status_id', 'status_name', 'description', 'is_assignable', 'is_borrowable'],
      where: { is_active: true },
      order: [['sort_order', 'ASC']],
      raw: true,
    }),
    distinctColumn(Equipment, 'manufacturer'),
    Department.findAll({
      attributes: ['department_id', 'department_code', 'department_name'],
      where: { is_active: true },
      order: [['department_code', 'ASC']],
      raw: true,
    }),
    distinctColumn(Employee, 'location'),
    distinctColumn(Employee, 'position'),
  ]);

  return {
    equipment: {
      // Now objects rather than plain strings, so the frontend can send
      // back the id while still showing the name in the dropdown.
      categories,
      device_types: deviceTypes,
      locations,
      departments,
      statuses,
      manufacturers,
    },
    employee: {
      departments: empDepartments,
      locations: empLocations,
      positions: empPositions,
    },
  };
}

// Everything the assign page needs on load, in one call rather than four -
// deliberately separate from getAllFilterOptions() above: these carry counts
// (how many people hold each position, how many of each category are still
// available) that a generic filter dropdown has no use for, and locations
// here means unowned equipment locations only, not every device's. Moved
// here from assignController.js, which used to run these queries itself.
async function getAssignFormData() {
  const [positions, statuses, categories, locations] = await Promise.all([
    Employee.findAll({
      attributes: ['position', [fn('COUNT', col('employee_id')), 'employee_count']],
      where: {
        position: { [Op.ne]: null },
        is_active: true,
        // LTRIM(RTRIM(position)) <> '' - a computed-expression condition,
        // not a plain column comparison, so it needs sequelize.where()
        // wrapping a raw fn() rather than a plain attribute key.
        [Op.and]: [sequelizeWhere(fn('LTRIM', fn('RTRIM', col('position'))), { [Op.ne]: '' })],
      },
      group: ['position'],
      order: [['position', 'ASC']],
      raw: true,
    }),
    EquipmentStatus.findAll({
      attributes: ['status_id', 'status_name', 'description', 'is_assignable'],
      where: { is_active: true },
      order: [['sort_order', 'ASC']],
      raw: true,
    }),
    // available_count is a conditional COUNT across a JOIN (category ->
    // equipment WHERE owner_id IS NULL) - stays raw, same reasoning as
    // every other correlated-aggregate read in this migration (e.g.
    // categoryModel.js's own equipment_count, viewColumnModel.js's
    // listViews()): a real fit for a SQL subquery, not for .findAll().
    sequelize.query(`
       SELECT c.category_id, c.category_name,
              (SELECT COUNT(*) FROM dbo.equipment e
                WHERE e.category_id = c.category_id AND e.owner_id IS NULL) AS available_count
       FROM dbo.category c WHERE c.is_active = 1 ORDER BY c.category_name
    `, { type: QueryTypes.SELECT }),
    // Same DISTINCT-via-GROUP-BY idea as the distinctColumn() helper, but
    // with an extra owner_id IS NULL condition the helper doesn't take a
    // parameter for - written directly instead of extending it for a
    // one-off.
    Equipment.findAll({
      attributes: ['location'],
      where: { location: { [Op.ne]: null }, owner_id: null },
      group: ['location'],
      order: [['location', 'ASC']],
      raw: true,
    }),
  ]);

  return {
    positions,
    statuses,
    categories,
    locations: locations.map((r) => r.location),
  };
}

module.exports = { getAllFilterOptions, getAssignFormData };
