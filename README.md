# Tplus API

REST API over the `Tplus` SQL Server database, organised as **MVC**.

## Project structure

```
tplus-api/
├── config/
│   └── sequelize.js           Sequelize connection - every model goes through this
├── models/                    ALL SQL lives here - nothing else touches the database
│   ├── employeeModel.js
│   ├── equipmentModel.js
│   ├── borrowModel.js         Temporary loans: dbo.borrow_record
│   ├── statusModel.js         Reference table: dbo.equipment_status
│   ├── departmentModel.js     Reference table: dbo.department
│   ├── categoryModel.js       Reference table: dbo.category
│   ├── userModel.js           Login accounts (dbo.api_user)
│   ├── searchModel.js
│   ├── filterModel.js
│   └── miscModel.js           SSD, licences, servers, antivirus, cloud
├── controllers/               Request validation and response shaping
│   ├── employeeController.js
│   ├── equipmentController.js
│   ├── borrowController.js
│   ├── statusController.js
│   ├── departmentController.js
│   ├── categoryController.js
│   ├── authController.js
│   ├── searchController.js
│   ├── filterController.js
│   ├── stockController.js
│   └── miscController.js
├── routes/                    Thin - just maps URLs to controller functions
│   ├── employeeRoutes.js
│   ├── equipmentRoutes.js
│   ├── borrowRoutes.js
│   ├── statusRoutes.js
│   ├── departmentRoutes.js
│   ├── categoryRoutes.js
│   ├── authRoutes.js
│   ├── searchRoutes.js
│   ├── filterRoutes.js
│   ├── stockRoutes.js
│   └── miscRoutes.js
├── middleware/
│   ├── auth.js                Checks username/password on every request
│   └── errorHandler.js        Central error handling + 404
├── server.js                  Wires everything together
└── create-admin.js            One-time script for the first admin account
```

### Why this layout

- **Models** are the only place that writes SQL. If a query needs changing, there's exactly one file to open.
- **Controllers** never touch the database. They validate input, call a model, and choose a status code.
- **Routes** contain no logic at all — you can read a route file and see every URL the API exposes in a few lines.

Adding a new endpoint means: add a model function, add a controller function, add one line to a route file.

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in your database details
3. Create the first admin: `node create-admin.js Tplus Tplus123@99 "Tplus Admin"`
4. `npm start`

## Authentication

Every endpoint except `/api/auth/login` needs credentials on **each** request:

```
?username=Tplus&password=Tplus123%4099        (the @ becomes %40 in a URL)
```
or
```
Authorization: Basic <base64 of "username:password">
```

```js
fetch(`${API}/api/employees/search?name=Fongmoua`, {
  headers: { Authorization: 'Basic ' + btoa('Tplus:Tplus123@99') }
});
```

### Security note

Sending the password on every request means it's repeatedly transmitted and
commonly ends up in server logs, browser history and proxy caches — and unlike a
token it never expires. This was a deliberate simplicity tradeoff. If the API is
later exposed more widely or handles more sensitive data, moving to token or
session auth would be worth revisiting.

## Roles and accounts

- `viewer` - read only
- `admin` - read, plus create/update employees, add stock, assign, borrow, and manage users

### Self-service signup

```json
POST /api/auth/signup
{ "username": "somchai", "password": "SomePassword123", "full_name": "Somchai Vongsa" }
```

Two things are fixed and cannot be overridden by the caller:

- **The role is always `viewer`.** Passing `"role": "admin"` in the body is ignored - otherwise anyone could make themselves an administrator.
- **The account starts inactive**, pending admin approval. Login returns 403 until approved.

Set `REQUIRE_ADMIN_APPROVAL=false` in `.env` for open signup. Worth thinking
about first: the API is reachable from the internet, so open signup means anyone
with the URL can read every employee, device and asset code.

Signup is throttled to 5 attempts per hour per IP.

### Managing accounts (admin)

| Action | Call |
|---|---|
| List accounts, see who is pending | `GET /api/users` |
| Approve a signup | `PUT /api/users/:id` with `{ "is_active": true }` |
| Change someone's role | `PUT /api/users/:id` with `{ "role": "admin" }` |
| Deactivate an account | `PUT /api/users/:id` with `{ "is_active": false }` |
| Reset a forgotten password | `POST /api/users/:id/reset-password` with `{ "new_password": "..." }` |

`GET /api/users` includes a `pending_approval` count, so the UI can badge the
Users menu when someone is waiting.

Password hashes are never returned by any user endpoint - the queries omit the
column rather than relying on the controller to strip it.

**Last-admin guard:** demoting or deactivating the only remaining active admin
is refused, since it would leave nobody able to manage the system.

## Endpoints

| Method | Endpoint | Access |
|---|---|---|
| POST | `/api/auth/login` | Public |
| GET | `/api/auth/me` | Any user |
| POST | `/api/auth/signup` | Public |
| POST | `/api/auth/register` | Admin |
| GET | `/api/users` | Admin |
| GET | `/api/users/:id` | Admin |
| PUT | `/api/users/:id` | Admin |
| POST | `/api/users/:id/reset-password` | Admin |
| GET | `/api/employees/search?name=X` | Any user |
| GET | `/api/employees` | Any user |
| GET | `/api/employees/:id` | Any user |
| GET | `/api/employees/:id/replacements` | Any user |
| POST | `/api/employees` | Admin |
| PUT | `/api/employees/:id` | Admin |
| DELETE | `/api/employees/:id` | Admin |
| GET | `/api/equipment` | Any user |
| GET | `/api/equipment/categories` | Any user |
| GET | `/api/equipment/:id` | Any user |
| PUT | `/api/equipment/:id/owner` | Admin |
| PUT | `/api/equipment/:id` | Admin |
| POST | `/api/stock/add` | Admin |
| POST | `/api/stock/assign` | Admin |
| GET | `/api/stock/available` | Any user |
| GET | `/api/stock/by-date` | Any user |
| GET | `/api/search?q=X` | Any user |
| GET | `/api/filters` | Any user |
| GET | `/api/licenses` | Any user |
| GET | `/api/server-usage` | Any user |
| GET | `/api/antivirus` | Any user |
| GET | `/api/replacements` | Any user |
| GET | `/api/departments` | Any user |
| GET | `/api/departments/:id` | Any user |
| POST | `/api/departments` | Admin |
| PUT | `/api/departments/:id` | Admin |
| GET | `/api/categories` | Any user |
| GET | `/api/categories/:id` | Any user |
| POST | `/api/categories` | Admin |
| PUT | `/api/categories/:id` | Admin |
| GET | `/api/statuses` | Any user |
| GET | `/api/statuses/:id` | Any user |
| GET | `/api/borrow/available` | Any user |
| GET | `/api/borrow/current` | Any user |
| GET | `/api/borrow/history` | Any user |
| GET | `/api/borrow/borrower/:id` | Any user |
| GET | `/api/borrow/:id` | Any user |
| POST | `/api/borrow` | Admin |
| POST | `/api/borrow/return` | Admin |
| POST | `/api/borrow/:id/return` | Admin |

## Editing and deleting

### Audit log

Successful updates and deletes are recorded with the acting account, action,
record type and ID, submitted changes, and time. Run
`migrations/20260803_add_audit_log.sql` once before deploying. Administrators
can read the newest entries from `GET /api/audit?limit=200`.

Authenticated non-admin users may update or delete employees, equipment details,
departments, and categories, and may unassign equipment before deleting a staff
member. Creating records, assigning equipment, stock actions, borrowing/returns,
and user-account management remain admin-only.

**Deletable (authenticated users, all guarded):** employees, departments, categories.

**Not deletable:** equipment and borrow records. Removing a device with borrow
history would orphan those records, and the history is usually the part worth
keeping. Retire equipment instead - `PUT` with `status: "Retired - IT Stock"`.

Every delete is refused while anything still references the record, and the
error says exactly what is blocking it:

```json
{
  "error": "Cannot delete Somchan Boulidam: they still have records attached",
  "references": { "owned_equipment": 3, "borrow_records": 1, ... },
  "hint": "Reassign their equipment to someone else first."
}
```

So in practice these only remove records with nothing attached - a duplicate
entered by mistake, a department created by typo. Anything with real history
stays.

### Employees who leave

Deleting them is the wrong tool. `borrow_record.borrower_id` is NOT NULL with a
foreign key, so the database blocks it - and the value of loan history is
knowing *who* had something. A record saying "someone borrowed the projector and
never returned it" is worse than no record.

Deactivate instead:

```json
PUT /api/employees/:id
{ "is_active": false, "left_date": "2026-07-30" }
```

They vanish from `GET /api/employees` (and so from every assign and borrow
dropdown), but their history stays intact and still resolves to a real name.
Use `?include_inactive=true` to see them again.

The delete refusal distinguishes two cases, so the UI can tell the user whether
it is something they can fix:

| Situation | Response |
|---|---|
| Items still on loan, or equipment assigned | `blocking` lists what to clear first |
| Everything returned, but past history exists | Explains the history would be lost, suggests deactivating |

**Edit equipment** - `PUT /api/equipment/:id` (admin). Send only the fields that
change; anything omitted is left alone. Accepts `category` / `department` as
name or id. Rejects an asset code or service tag that would clash with another
record.

**Instead of deleting:**

| Situation | What to do |
|---|---|
| Device scrapped | `PUT /api/equipment/:id` with `status: "Retired - IT Stock"` |
| Device faulty | `status: "Broken - IT Stock"` |
| Department or category created by mistake | `PUT` with `is_active: false` - it disappears from dropdowns but existing records keep working |

Retired and inactive records stay in the database and keep their history, but
drop out of the assign and borrow lists.

## Borrow and return

Temporary loans, kept separate from ownership:

- `equipment.owner_id` + `assigned_date` = permanent company-issued device
- `borrow_record` = temporary loan; the item returns to stock afterwards

Borrowing never changes `owner_id` - that stays for permanent assignment.

**Status changes automatically:**

```
Working - IT Stock  --borrow-->  Borrowed  --return-->  Working - IT Stock
```

Both the loan record and the status change happen in a single transaction, so
they cannot disagree - there is no path to a loan whose equipment still looks
available, or an item marked Borrowed with no matching record.

**Who has it** is joined live from the open loan rather than stored on the
equipment row, so it is always accurate. Equipment responses include:

```
current_borrow_id, current_borrower, borrowed_on, due_back
```

All null when the item is not out.

**Damaged returns:** pass `return_status` to send an item somewhere other than
back into the borrowable pool:
```json
POST /api/borrow/return
{ "equipment_id": 733, "return_status": "Broken - IT Stock",
  "condition_on_return": "Screen cracked" }
```

**An item can only be borrowed when all of these hold:**

1. It exists
2. It has no owner (an owned device is someone's permanent machine)
3. Its status is `Working - IT Stock`
4. It is not already out on loan

Each failure returns a specific 409 or 404 explaining which rule was hit -
including who currently owns or holds it - so the UI can show a useful message
rather than a generic error.

**Borrow**
```json
POST /api/borrow
{
  "equipment_id": 660,
  "full_name": "Maneekone",
  "borrow_date": "2026-07-28",
  "expected_return_date": "2026-08-04",
  "condition_on_borrow": "Good",
  "purpose": "Presentation in meeting room 2"
}
```
`borrower_id` may be used instead of `full_name`. `borrow_date` defaults to today.

**Return** - by loan id, or by equipment id if the UI only knows the item:
```json
POST /api/borrow/12/return
POST /api/borrow/return   { "equipment_id": 660 }

{ "return_date": "2026-08-03", "condition_on_return": "Good", "received_by_id": 22 }
```

**Queries**
- `GET /api/borrow/available?category=Monitor` - what can be borrowed now
- `GET /api/borrow/current?overdue=true` - what is out, with `days_out` and `is_overdue`
- `GET /api/borrow/returns` - the Returns page: what has come back
- `GET /api/borrow/history?borrower_id=2&from=2026-01-01` - all loans, out and returned
- `GET /api/borrow/borrower/2?open=true` - one person's loans

### The Returns page

`GET /api/borrow/returns` lists returned loans only, newest first. Filters:
`from`, `to` (on return date), `borrower_id`, `equipment_id`, `late_only=true`.

Each row carries the figures a returns page needs, worked out server-side:

| Field | Meaning |
|---|---|
| `return_date` | When it came back |
| `days_kept` | How long they had it |
| `was_late` / `days_late` | Returned after the expected date |
| `condition_on_return` | Free text - "Good", "Screen cracked", etc. |
| `current_status` | Where the item went afterwards |
| `received_by` | Who took it back, if recorded |

The response also includes `late_count` alongside `count`, so a summary line
needs no client-side filtering.

### Equipment status

Status is a reference table (`dbo.equipment_status`), not free text - the same
approach as department and category. That stops a typo like "workingg" being
saved, and means the dropdown always shows every valid option even when no
equipment currently has that status.

| Status | Owner | Meaning | Assignable | Borrowable |
|---|---|---|---|---|
| `Working/Using` | Yes | Works, in use | No | No |
| `Working - IT Stock` | No | In the cupboard | **Yes** | **Yes** |
| `Installed` | No | Mounted or racked in service - CCTV, access control, network devices, servers | No | No |
| `Broken` | Yes | Owned but faulty | No | No |
| `Broken - IT Stock` | No | In stock but faulty | No | No |
| `Retired - IT Stock` | No | End of life | No | No |
| `Borrowed` | No | Temporarily out on loan | No | No |

`Installed` exists so wall-mounted cameras and racked servers don't appear in the
assign or borrow lists simply because nobody owns them.

**For the frontend:** `GET /api/statuses` returns all six with `is_assignable`
and `is_borrowable` flags. Use it to populate the dropdown and to grey out
actions that aren't possible - no need to hardcode the rules client-side.

The API drives its own checks off those same flags, so changing which statuses
allow borrowing is a data change rather than a code change.

**Filtering:** `GET /api/equipment?category=Laptop&status=Working - IT Stock`
(or `status_id=2`). Both filters combine.

### Owner details on equipment

Equipment responses include the owner's details alongside the device, so a
results table can show who has something without a second lookup:

```
owner_name, owner_position, owner_department, owner_department_name,
owner_location, owner_staff_code
```

All are `null` for unassigned stock, which is the correct answer rather than a
missing field - the frontend can show "In stock" when `owner_name` is null.

Note that `department_code` (the device's department) and `owner_department`
(the person's department) are separate fields. They usually match, but not
always - a laptop bought by IT and issued to Sales would differ.

## Departments and categories

These used to be free text on `employee` and `equipment`. They are now
proper tables linked by `department_id` and `category_id`.

**What this means for the frontend:**

- `GET /api/departments` and `GET /api/categories` return the full list with
  usage counts - ideal for populating dropdowns.
- Responses still include the readable name (`department_code`,
  `category_name`) alongside the id, so nothing needs to do a second lookup
  just to display a row.
- When creating or updating, you can send **either** the id or the name:
  `{"category": "Laptop"}` and `{"category_id": 5}` both work. Unknown names
  return a 400 listing where to find the valid values.
- Deleting a department or category that is still in use returns 409 with the
  counts, rather than a raw foreign key error.

Equipment filters are combinable:
```
/api/equipment?category=Server&location=VTE&department=TIT&status=Operational&unowned=true&q=probook
```

## Stock workflow

**1. New device arrives** → `POST /api/stock/add`
```json
{
  "category": "Computer",
  "device_type": "Laptop",
  "device_model": "HP ProBook 440 G10",
  "manufacturer": "HP",
  "equipment_code": "AIT0250",
  "service_tag": "5CD4414ABC",
  "cpu": "i5-1340P", "ram": "16", "hd": "512",
  "purchase_date": "2026-01-01",
  "received_date": "2026-01-05"
}
```
Goes in unassigned. Duplicate asset codes and service tags are rejected.

**2. Hand it to someone** → `POST /api/stock/assign`
```json
{
  "equipment_id": 800,
  "full_name": "Somchan Boulidam",
  "assigned_date": "2026-01-10",
  "computer_name": "LSale-Somchan",
  "ip_address": "166.24.12.50"
}
```

`department` and `location` are optional - the device inherits them from the
employee, since a person's device normally sits with the person. Send them
explicitly only for the exception, e.g. a machine kept at a different site to
its owner. The response includes `inherited_from_employee` so the UI can show
which values were filled in automatically.

Status is set to `Working/Using` automatically, so the item leaves the stock and
borrow lists.

Refuses to overwrite an existing owner - it tells you who has it instead.

**3. What's still in stock** → `GET /api/stock/available?category=Computer`

**4. What arrived in January** → `GET /api/stock/by-date?from=2026-01-01&to=2026-01-31`
