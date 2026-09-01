const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
require('dotenv').config();

const authRoutes = require('./routes/authRoutes');
const employeeRoutes = require('./routes/employeeRoutes');
const equipmentRoutes = require('./routes/equipmentRoutes');
const searchRoutes = require('./routes/searchRoutes');
const filterRoutes = require('./routes/filterRoutes');
const stockRoutes = require('./routes/stockRoutes');
const departmentRoutes = require('./routes/departmentRoutes');
const categoryRoutes = require('./routes/categoryRoutes');
const borrowRoutes = require('./routes/borrowRoutes');
const statusRoutes = require('./routes/statusRoutes');
const userRoutes = require('./routes/userRoutes');
const auditRoutes = require("./routes/auditRoutes");
const recycleBinRoutes = require("./routes/recycleBinRoutes");
const assignRoutes = require("./routes/assignRoutes");
const { notFound, errorHandler } = require('./middleware/errorHandler');
const viewColumnRoutes = require("./routes/viewColumnRoutes");
const partRoutes = require("./routes/partRoutes");
const partReplacementRoutes = require("./routes/partReplacementRoutes");
const customFieldRoutes = require("./routes/customFieldRoutes");
const partStockRoutes = require("./routes/partStockRoutes");
const partStatusRoutes = require("./routes/partStatusRoutes");
const partCustomFieldRoutes = require("./routes/partCustomFieldRoutes");
const partBorrowRoutes = require("./routes/partBorrowRoutes");
const reportRoutes = require("./routes/reportRoutes");
const licenseRoutes = require("./routes/licenseRoutes");
const serverUsageRoutes = require("./routes/serverUsageRoutes");
const antivirusInstallRoutes = require("./routes/antivirusInstallRoutes");
const deviceReplacementRoutes = require("./routes/deviceReplacementRoutes");

const app = express();

app.use(helmet());

// CORS_ORIGIN in .env restricts which site(s) a browser will let call this
// API from - comma-separated for more than one (e.g. a staging frontend and
// a production one). Left unset, this falls back to allowing any origin
// (Express's cors() default) - fine for local development against a frontend
// whose URL isn't fixed yet, but this should be set once the real frontend's
// address is known, per the security note further down.
const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((o) => o.trim())
  : null;
app.use(cors(allowedOrigins ? { origin: allowedOrigins } : {}));

app.use(express.json());

// Simple request log - handy in development. The query string is stripped,
// not just logged as-is: this API's auth accepts ?username=&password= on
// every request (see the Authentication section in README.md), so logging
// req.originalUrl verbatim would write every plaintext password straight
// into the console/log file on every authenticated call.
app.use((req, res, next) => {
  const pathOnly = req.originalUrl.split('?')[0];
  console.log(`${new Date().toISOString()} ${req.method} ${pathOnly}`);
  next();
});

// API index - lists everything available
app.get('/', (req, res) => {
  res.json({
    message: "Tplus API is running",
    architecture:
      "MVC - routes define URLs, controllers handle requests, models hold all SQL",
    note: "Every endpoint except /api/auth/login requires username and password. Send as ?username=X&password=Y or via Basic auth header.",
    endpoints: {
      auth: {
        login: "POST /api/auth/login  { username, password }",
        me: "GET /api/auth/me",
        signup:
          "POST /api/auth/signup  (public) { username, password, full_name } - always creates a viewer, pending admin approval",
        register:
          "POST /api/auth/register  (admin only) - create an account directly, any role",
      },
      users: {
        list: "GET /api/users  (admin) - all accounts, with pending_approval count",
        one: "GET /api/users/:id  (admin)",
        update:
          'PUT /api/users/:id  (admin) - change role, name, or approve a signup with { "is_active": true }',
        resetPassword:
          "POST /api/users/:id/reset-password  (admin) { new_password }",
      },
      audit: {
        list: "GET /api/audit?limit=200  (admin only) - update/delete activity, newest first",
      },
      employees: {
        search:
          "GET /api/employees/search?name=Fongmoua  - person plus all their devices",
        list: "GET /api/employees  - active staff only; add ?include_inactive=true for leavers too",
        one: "GET /api/employees/:id",
        full: "GET /api/employees/:id/full  - employee info plus one entry per owned device, each shaped by its category's configured columns/custom fields - built for a detail page with an info card and one card per device",
        replacements: "GET /api/employees/:id/replacements  - historical whole-device swaps only (feature retired, old records kept)",
        partReplacements: "GET /api/employees/:id/part-replacements  - every part swapped across all devices this employee currently owns",
        create: "POST /api/employees  (admin only)",
        update:
          'PUT /api/employees/:id  (admin only) - also how you deactivate a leaver: { "is_active": false, "left_date": "2026-07-30" }',
        remove:
          "DELETE /api/employees/:id  (admin only, refused if they own equipment or have loan history)",
      },
      equipment: {
        list: "GET /api/equipment",
        filters:
          "GET /api/equipment?category=Server&location=VTE&department=TIT&status=Operational&unowned=true&q=probook",
        categories: "GET /api/equipment/categories",
        one: "GET /api/equipment/:id",
        reassignOwner: "PUT /api/equipment/:id/owner  (admin only)",
        unassign:
          "POST /api/equipment/unassign  (admin only)  { equipment_id | equipment_ids | owner_id, status }",
        update: "PUT /api/equipment/:id  (admin only) - edit any detail",
      },
      stock: {
        add: "POST /api/stock/add  (admin only) - add one new device into stock",
        assign:
          "POST /api/stock/assign  (admin only) - hand a stock device to an employee",
        available: "GET /api/stock/available?category=Computer",
        byDate: "GET /api/stock/by-date?from=2026-01-01&to=2026-01-31",
      },
      departments: {
        list: "GET /api/departments  - all departments with employee and equipment counts",
        one: "GET /api/departments/:id",
        create:
          "POST /api/departments  (admin only)  { department_code, department_name }",
        update: "PUT /api/departments/:id  (admin only)",
      },
      statuses: {
        list: "GET /api/statuses  - all equipment statuses for dropdowns, with is_assignable / is_borrowable flags",
        one: "GET /api/statuses/:id",
      },
      categories: {
        list: "GET /api/categories  - all categories with equipment counts",
        one: "GET /api/categories/:id",
        create:
          "POST /api/categories  (admin only)  { category_name, description }",
        update: "PUT /api/categories/:id  (admin only)",
      },
      borrow: {
        available:
          "GET /api/borrow/available?category=Monitor  - what can be borrowed right now",
        current: "GET /api/borrow/current?overdue=true  - what is out on loan",
        history:
          "GET /api/borrow/history?equipment_id=&borrower_id=&from=&to=  - all loans, out and returned",
        returns:
          "GET /api/borrow/returns?from=&to=&borrower_id=&late_only=true  - returned loans only, with days_kept and was_late",
        byBorrower:
          "GET /api/borrow/borrower/:id?open=true  - one person's loans",
        one: "GET /api/borrow/:id",
        borrow:
          "POST /api/borrow  (admin)  { equipment_id, borrower_id | full_name, borrow_date, expected_return_date }",
        returnByEquipment:
          "POST /api/borrow/return  (admin)  { equipment_id, return_date, condition_on_return }",
        returnByBorrowId: "POST /api/borrow/:id/return  (admin)",
      },
      lookup: {
        universalSearch:
          "GET /api/search?q=anything  - searches employees AND equipment",
        filterOptions: "GET /api/filters  - dropdown values for the frontend",
      },
      reports: {
        equipment:
          "GET /api/reports/equipment?format=xlsx|pdf  - exports the equipment list (same filters as GET /api/equipment)",
        employees:
          "GET /api/reports/employees?format=xlsx|pdf&include_inactive=true  - every employee with their owned equipment; no-equipment employees get one row",
        borrowHistory:
          "GET /api/reports/borrow-history?format=xlsx|pdf  (same filters as GET /api/borrow/history)",
        partStock:
          "GET /api/reports/part-stock?format=xlsx|pdf  (same filters as GET /api/part-stock)",
      },
      other: {
        licenses: "GET /api/licenses",
        createLicense: "POST /api/licenses",
        serverUsage: "GET /api/server-usage",
        antivirus: "GET /api/antivirus",
      },
    },
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/equipment', equipmentRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/filters', filterRoutes);
app.use('/api/stock', stockRoutes);
app.use('/api/departments', departmentRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/borrow', borrowRoutes);
app.use('/api/statuses', statusRoutes);
app.use('/api/users', userRoutes);
app.use("/api/audit", auditRoutes);
app.use("/api/recycle-bin", recycleBinRoutes);
app.use("/api/view-columns", viewColumnRoutes);
app.use("/api/custom-fields", customFieldRoutes);
app.use("/api/assign", assignRoutes);
app.use("/api/part-types", partRoutes);
app.use("/api/part-replacements", partReplacementRoutes);
app.use("/api/part-stock", partStockRoutes);
app.use("/api/part-statuses", partStatusRoutes);
app.use("/api/part-custom-fields", partCustomFieldRoutes);
app.use("/api/part-borrow", partBorrowRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/licenses", licenseRoutes);
app.use("/api/server-usage", serverUsageRoutes);
app.use("/api/antivirus", antivirusInstallRoutes);
app.use("/api/replacements", deviceReplacementRoutes);
app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Tplus API listening on http://localhost:${PORT}`);
});
