const equipmentModel = require('../models/equipmentModel');
const employeeModel = require('../models/employeeModel');
const borrowModel = require('../models/borrowModel');
const partStockModel = require('../models/partStockModel');
const { sendExcel, sendPdf } = require('../utils/reportExport');

function resolveFormat(req, res) {
  const format = (req.query.format || 'xlsx').toLowerCase();
  if (format !== 'xlsx' && format !== 'pdf') {
    res.status(400).json({ error: 'format must be "xlsx" or "pdf"' });
    return null;
  }
  return format;
}

async function sendReport(req, res, filename, title, columns, rows) {
  const format = resolveFormat(req, res);
  if (!format) return;
  if (format === 'pdf') {
    sendPdf(res, filename, title, columns, rows);
  } else {
    await sendExcel(res, filename, title, columns, rows);
  }
}

const EQUIPMENT_COLUMNS = [
  { key: 'category_name', header: 'Category' },
  { key: 'computer_name', header: 'Computer Name' },
  { key: 'device_model', header: 'Model' },
  { key: 'manufacturer', header: 'Manufacturer' },
  { key: 'asset_code', header: 'Asset Code' },
  { key: 'service_tag', header: 'Service Tag' },
  { key: 'status_name', header: 'Status' },
  { key: 'owner_name', header: 'Owner' },
  { key: 'owner_department', header: 'Owner Dept' },
  { key: 'location', header: 'Location' },
];

// Same filters as GET /api/equipment (category, location, department, status,
// q, unowned) - a report is just that list exported instead of returned as JSON.
async function equipmentReport(req, res, next) {
  try {
    const rows = await equipmentModel.findAll(req.query);
    await sendReport(req, res, 'equipment-report', 'Equipment Report', EQUIPMENT_COLUMNS, rows);
  } catch (err) {
    next(err);
  }
}

const EMPLOYEE_EQUIPMENT_COLUMNS = [
  { key: 'full_name', header: 'Employee' },
  { key: 'staff_code', header: 'Staff Code' },
  { key: 'department_name', header: 'Department' },
  { key: 'position', header: 'Position' },
  { key: 'has_equipment', header: 'Has Equipment' },
  { key: 'category_name', header: 'Category' },
  { key: 'device_name', header: 'Equipment' },
  { key: 'asset_code', header: 'Asset Code' },
  { key: 'device_status', header: 'Status' },
];

// One row per owned device; an employee with nothing owned still appears,
// once, with the equipment columns filled in as "(No equipment)" - so the
// report answers "who has gear and who doesn't" without a separate summary.
async function employeeReport(req, res, next) {
  try {
    const includeInactive = req.query.include_inactive === 'true';
    const raw = await employeeModel.findAllWithEquipment(includeInactive);

    const rows = raw.map((r) => ({
      ...r,
      has_equipment: r.equipment_id ? 'Yes' : 'No',
      category_name: r.equipment_id ? r.category_name : '(No equipment)',
      device_name: r.equipment_id ? [r.computer_name, r.device_model].filter(Boolean).join(' - ') : '',
    }));

    await sendReport(
      req,
      res,
      'employee-equipment-report',
      'Employee Equipment Report',
      EMPLOYEE_EQUIPMENT_COLUMNS,
      rows,
    );
  } catch (err) {
    next(err);
  }
}

const BORROW_COLUMNS = [
  { key: 'category_name', header: 'Category' },
  { key: 'computer_name', header: 'Computer Name' },
  { key: 'asset_code', header: 'Asset Code' },
  { key: 'borrower_name', header: 'Borrower' },
  { key: 'borrower_department', header: 'Dept' },
  { key: 'borrow_date', header: 'Borrow Date' },
  { key: 'expected_return_date', header: 'Due Back' },
  { key: 'return_date', header: 'Returned' },
  { key: 'loan_status', header: 'Status' },
];

// Same filters as GET /api/borrow/history (equipment_id, borrower_id, from, to).
async function borrowReport(req, res, next) {
  try {
    const rows = await borrowModel.findHistory(req.query);
    await sendReport(
      req,
      res,
      'borrow-history-report',
      'Borrow History Report',
      BORROW_COLUMNS,
      rows,
    );
  } catch (err) {
    next(err);
  }
}

const PART_STOCK_COLUMNS = [
  { key: 'part_name', header: 'Part' },
  { key: 'part_value', header: 'Value' },
  { key: 'model_name', header: 'Model' },
  { key: 'model_number', header: 'Model No.' },
  { key: 'status', header: 'Status' },
  { key: 'quantity', header: 'Qty' },
  { key: 'location', header: 'Location' },
  { key: 'remark', header: 'Remark' },
];

// Same filters as GET /api/part-stock (part_type_id, status, in_stock_only).
async function partStockReport(req, res, next) {
  try {
    const rows = await partStockModel.findAll(req.query);
    await sendReport(req, res, 'part-stock-report', 'Part Stock Report', PART_STOCK_COLUMNS, rows);
  } catch (err) {
    next(err);
  }
}

module.exports = { equipmentReport, employeeReport, borrowReport, partStockReport };
