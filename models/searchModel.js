const { Op } = require('sequelize');
const { Equipment } = require('./equipmentModel');
const { Category } = require('./categoryModel');
const { Department } = require('./departmentModel');
const { Employee } = require('./employeeModel');

// Universal search across employees AND equipment.
// Returns one flat array so the frontend can render a single results table;
// each row carries a match_type so the UI can badge them differently.
//
// The original was a hand-built UNION ALL with NULL-padding to align column
// counts between two very different entity shapes - Sequelize has no UNION
// builder, so the two halves are two independent ORM reads (reusing
// associations already declared in equipmentModel.js/employeeModel.js)
// shaped to match and merged in JS, same "merge separate ORM reads in JS"
// pattern used throughout this migration, applied here to a UNION instead
// of a correlated aggregate.
async function searchAll(term) {
  const like = `%${term.trim()}%`;

  const equipmentRows = await Equipment.findAll({
    where: {
      [Op.or]: [
        { device_name: { [Op.like]: like } },
        { computer_name: { [Op.like]: like } },
        { device_model: { [Op.like]: like } },
        { asset_code: { [Op.like]: like } },
        { service_tag: { [Op.like]: like } },
        { mac_address: { [Op.like]: like } },
        { ip_address: { [Op.like]: like } },
        { manufacturer: { [Op.like]: like } },
        { '$category.category_name$': { [Op.like]: like } },
        { device_type: { [Op.like]: like } },
        { location: { [Op.like]: like } },
        { '$department.department_code$': { [Op.like]: like } },
        { status: { [Op.like]: like } },
        { remark: { [Op.like]: like } },
        { cpu: { [Op.like]: like } },
        { '$owner.full_name$': { [Op.like]: like } },
      ],
    },
    include: [
      { model: Category, as: 'category', attributes: ['category_name'], required: false },
      { model: Department, as: 'department', attributes: ['department_code'], required: false },
      {
        model: Employee, as: 'owner', required: false,
        attributes: ['employee_id', 'full_name', 'position', 'location'],
        include: [{ model: Department, as: 'department', attributes: ['department_code'], required: false }],
      },
    ],
    // Within this group only - see the note below on why cross-group
    // ordering doesn't need this same care. The original had no tiebreaker
    // beyond owner_name/computer_name, so rows tied on both (e.g. two
    // unowned devices with no computer_name) had an undefined relative
    // order - confirmed live (same result SET either way, only tie order
    // differed). equipment_id makes this deterministic rather than
    // reshuffling between requests, which matters more for a paged search
    // result than it did for the JSON-key-order cases earlier in this
    // migration.
    order: [[{ model: Employee, as: 'owner' }, 'full_name', 'ASC'], ['computer_name', 'ASC'], ['equipment_id', 'ASC']],
    subQuery: false,
  });

  const equipmentResults = equipmentRows.map((row) => {
    const { category, department, owner, ...e } = row.get({ plain: true });
    return {
      match_type: 'Equipment',
      equipment_id: e.equipment_id,
      category: category ? category.category_name : null,
      device_name: e.device_name,
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
      device_location: e.location,
      device_department: department ? department.department_code : null,
      device_status: e.status,
      remark: e.remark,
      employee_id: owner ? owner.employee_id : null,
      owner_name: owner ? owner.full_name : null,
      owner_position: owner ? owner.position : null,
      owner_department: owner && owner.department ? owner.department.department_code : null,
      owner_location: owner ? owner.location : null,
    };
  });

  // Employees who own nothing still need to appear in results - the
  // NOT EXISTS becomes "exclude anyone who owns at least one piece of
  // equipment", fetched once and applied via Op.notIn (same pattern as
  // borrowModel.findAvailableToBorrow's open-loan exclusion).
  const owners = await Equipment.findAll({
    where: { owner_id: { [Op.ne]: null } }, attributes: ['owner_id'], raw: true,
  });
  const ownerIds = [...new Set(owners.map((r) => r.owner_id))];

  const employeeWhere = {
    [Op.or]: [
      { full_name: { [Op.like]: like } },
      { position: { [Op.like]: like } },
      { '$department.department_code$': { [Op.like]: like } },
      { location: { [Op.like]: like } },
      { staff_code: { [Op.like]: like } },
    ],
  };
  if (ownerIds.length > 0) employeeWhere.employee_id = { [Op.notIn]: ownerIds };

  const employeeRows = await Employee.findAll({
    where: employeeWhere,
    attributes: ['employee_id', 'full_name', 'position', 'location'],
    include: [{ model: Department, as: 'department', attributes: ['department_code'], required: false }],
    order: [['full_name', 'ASC'], ['employee_id', 'ASC']],
    subQuery: false,
  });

  const employeeResults = employeeRows.map((row) => {
    const { department, ...emp } = row.get({ plain: true });
    return {
      match_type: 'Employee',
      equipment_id: null,
      category: null,
      device_name: null,
      device_type: null,
      computer_name: null,
      device_model: null,
      manufacturer: null,
      asset_code: null,
      service_tag: null,
      mac_address: null,
      ip_address: null,
      cpu: null,
      ram: null,
      hd: null,
      device_location: null,
      device_department: null,
      device_status: null,
      remark: null,
      employee_id: emp.employee_id,
      owner_name: emp.full_name,
      owner_position: emp.position,
      owner_department: department ? department.department_code : null,
      owner_location: emp.location,
    };
  });

  // ORDER BY match_type, owner_name, computer_name in the original - but
  // match_type is always exactly 'Employee' or 'Equipment' (never data-
  // dependent), and 'Employee' sorts before 'Equipment' under every
  // collation (the third character alone, 'm' vs 'q', already decides it),
  // so the two groups never actually interleave. That leaves each group
  // only needing to be correctly ordered WITHIN itself - done above via
  // each query's own `order`, so SQL Server's own collation decides it
  // (not a JS approximation - see employeeModel.findAllWithEquipment's
  // earlier fix in this migration for why a JS string sort risked
  // disagreeing with SQL's collation on this exact kind of name data).
  // Concatenating the two pre-sorted groups reproduces the UNION's combined
  // order with no further comparison needed.
  return [...employeeResults, ...equipmentResults];
}

module.exports = { searchAll };
