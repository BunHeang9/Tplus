const express = require('express');
const cors = require('cors');
require('dotenv').config();

const authRoutes = require('./routes/authRoutes');
const employeeRoutes = require('./routes/employeeRoutes');
const equipmentRoutes = require('./routes/equipmentRoutes');
const searchRoutes = require('./routes/searchRoutes');
const filterRoutes = require('./routes/filterRoutes');
const stockRoutes = require('./routes/stockRoutes');
const miscRoutes = require('./routes/miscRoutes');
const departmentRoutes = require('./routes/departmentRoutes');
const categoryRoutes = require('./routes/categoryRoutes');
const borrowRoutes = require('./routes/borrowRoutes');
const statusRoutes = require('./routes/statusRoutes');
const userRoutes = require('./routes/userRoutes');
const auditRoutes = require("./routes/auditRoutes");
const recycleBinRoutes = require("./routes/recycleBinRoutes");

const { notFound, errorHandler } = require('./middleware/errorHandler');
const viewColumnRoutes = require("./routes/viewColumnRoutes");
const customFieldRoutes = require("./routes/customFieldRoutes");

const app = express();

app.use(cors());
app.use(express.json());

// Simple request log - handy in development
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl}`);
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
        replacements: "GET /api/employees/:id/replacements",
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
      other: {
        ssdUpgrades: "GET /api/ssd-upgrades",
        ssdProcurement: "GET /api/ssd-procurement",
        licenses: "GET /api/licenses",
        createLicense: "POST /api/licenses",
        serverUsage: "GET /api/server-usage",
        antivirus: "GET /api/antivirus",
        replacements: "GET /api/replacements",
        cloudRates: "GET /api/cloud-rates",
        cloudUsage: "GET /api/cloud-usage",
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
// Mounted at /api, so this catch-all must come last or it swallows
// every more specific route declared after it.
app.use("/api", miscRoutes);
app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Tplus API listening on http://localhost:${PORT}`);
});
