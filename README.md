# Tplus API

REST API over the `Tplus` SQL Server database, organised as **MVC**, on **Sequelize**.

## Tech stack

| | |
|---|---|
| **Runtime** | Node.js |
| **Framework** | [Express](https://expressjs.com/) 4 |
| **Database** | SQL Server, via [Sequelize](https://sequelize.org/) 6 ([tedious](https://github.com/tediousjs/tedious) as the driver underneath) |
| **Auth** | [bcryptjs](https://github.com/dcodeIO/bcrypt.js) for password hashing - Basic Auth on every request (see Authentication below), no session/token layer |
| **Testing** | [Jest](https://jestjs.io/) - see Testing below |
| **Exports** | [exceljs](https://github.com/exceljs/exceljs) (`.xlsx`) and [pdfkit](http://pdfkit.org/) (`.pdf`) for `/api/reports/*` |
| **Security headers** | [helmet](https://helmetjs.github.io/) |
| **Email** | [nodemailer](https://nodemailer.com/) for password-reset emails (see `SMTP_*` in `.env.example` - unconfigured, it logs the reset link instead of sending) |
| **Dev** | [nodemon](https://nodemon.io/) for auto-restart, [dotenv](https://github.com/motdotla/dotenv) + `.env` for config, [cors](https://github.com/expressjs/cors) (see `CORS_ORIGIN` in `.env.example`) |

That's the whole list - `package.json` has 10 runtime dependencies and 2 dev
ones, on purpose. No ORM plugins, no validation framework, no logging
library: request validation is hand-written per controller, and there is
currently no structured logger (see "What's not here yet" below).

No TypeScript - this is plain JavaScript (CommonJS, `require`/`module.exports`)
throughout.

### What's not here yet

Worth knowing if you're picking this up fresh: no CI pipeline, no linter
config, and `console.log`/`console.error` (a small, deliberate footprint -
7 call sites total, all in `server.js`/`config/sequelize.js`/`middleware/`)
rather than a structured logger. Rate limiting exists only as a narrow,
hand-rolled, in-memory throttle on `/api/auth/signup` (see below) - nothing
app-wide, and nothing that would survive a restart or work across more than
one process; `/api/auth/login` itself has none. None of these block running
the app - they're the natural next layer of maturity, not missing pieces the
app depends on.

## Project structure

```
tplus-api/
├── config/
│   └── sequelize.js            The one connection every model goes through
├── models/                     ALL SQL lives here - nothing else touches the database
│   ├── employeeModel.js
│   ├── equipmentModel.js
│   ├── departmentModel.js      Reference table: dbo.department
│   ├── categoryModel.js        Reference table: dbo.category
│   ├── statusModel.js          Reference table: dbo.equipment_status
│   ├── borrowModel.js          Equipment loans: dbo.borrow_record
│   ├── deviceReplacementModel.js  Whole-device swaps: dbo.device_replacement
│   ├── antivirusInstallModel.js
│   ├── serverUsageModel.js     Capacity-planning history log
│   ├── softwareLicenseModel.js
│   ├── customFieldModel.js     Per-category custom attributes on equipment
│   ├── viewColumnModel.js      Per-category configurable equipment table columns
│   ├── partModel.js            Part types + fitting/replacing a part on a device
│   ├── partStockModel.js       Spare-part inventory
│   ├── partStatusModel.js      Reference table: dbo.part_stock_status
│   ├── partStockColumnModel.js Per-part-type configurable stock form columns
│   ├── partCustomFieldModel.js Per-part-type custom attributes
│   ├── partBorrowModel.js      Loose-part loans (bags, mice, keyboards)
│   ├── recycleBinModel.js      Soft-deleted records awaiting restore
│   ├── auditModel.js           Who changed what, and when
│   ├── userModel.js            Login accounts (dbo.api_user)
│   ├── searchModel.js          Universal search across employees and equipment
│   └── filterModel.js          Dropdown option lists for the equipment filters
├── controllers/                Request validation and response shaping - never touches the database
├── routes/                     Thin - just maps URLs to controller functions
├── middleware/
│   ├── auth.js                 Checks credentials on every request
│   ├── auditActivity.js        Records successful updates/deletes to dbo.audit_log
│   └── errorHandler.js         Central error handling + 404
├── tests/                      See "Testing" below
├── server.js                   Wires everything together
└── create-admin.js             One-time script for the first admin account
```

Every model file above has a matching `xController.js` and `xRoutes.js` - e.g.
`partStockModel.js` → `partStockController.js` → `partStockRoutes.js`. That
pairing is 1:1 throughout the app, so it isn't repeated here.

### Why this layout

- **Models** are the only place that writes SQL - all of it through Sequelize now, with a
  short, deliberate list of exceptions where the ORM genuinely can't express something (a
  real time-of-check/time-of-use race, an atomic MERGE avoiding a duplicate-insert race, an
  `IDENTITY_INSERT` restore, or a bare `SELECT GETDATE()`) - each one commented in place with
  why. If a query needs changing, there's exactly one file to open.
- **Controllers** never touch the database. They validate input, call a model, and choose a status code.
- **Routes** contain no logic at all — you can read a route file and see every URL the API exposes in a few lines.

Adding a new endpoint means: add a model function, add a controller function, add one line to a route file.

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in your database details
3. Create the first admin: `node create-admin.js Tplus Tplus123@99 "Tplus Admin"`
4. `npm start` (or `npm run dev` for auto-restart on file changes)

## Testing

```
npm test
```

Runs the Jest suite in `tests/` - some of it pure-function unit tests (no
database needed), some of it full lifecycle tests against real Sequelize
models. **There is no separate test database** - `config/sequelize.js` points
at one database, and any DB-backed test runs against that same one. See
`tests/README.md` for the resulting rule: a test may only ever create and
delete its own scratch rows, never touch a real record. Every test currently
in the suite follows that discipline.

## Authentication

Every endpoint needs credentials on **each** request, except the three public
ones - `/api/auth/login`, `/api/auth/signup`, and the password-reset pair
(`/api/auth/forgot-password`/`/api/auth/reset-password`, which don't take
credentials at all - see Password reset below for how those are secured
instead):

```
?username=Tplus&password=Tplus123%4099        (the @ becomes %40 in a URL)
```
or
```
Authorization: Basic <base64 of "username:password">
```

The identifier accepts either a real username or an email address - both
`login` and every other request's credential check resolve it the same way
(`userModel.findByUsernameOrEmail()`), so whichever one a user's frontend
account uses stays working consistently across the whole session, not just
at the login call.

```js
fetch(`${API}/api/employees/search?name=Fongmoua`, {
  headers: { Authorization: 'Basic ' + btoa('Tplus:Tplus123@99') }
});
```

### Security note

Sending the password on every request means it's repeatedly transmitted and
commonly ends up in browser history and proxy caches — and unlike a token it
never expires. This was a deliberate simplicity tradeoff. If the API is
later exposed more widely or handles more sensitive data, moving to token or
session auth would be worth revisiting.

It no longer ends up in *this app's own* server logs, at least - the request
logger in `server.js` strips the query string before logging, specifically
because this auth scheme puts the password there. Nothing stops it from
still showing up in browser history or an intermediate proxy's logs, which is
the deeper reason token auth would be the real fix, not just a log tweak.

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
| Reset someone else's forgotten password | `POST /api/users/:id/reset-password` with `{ "new_password": "..." }` - deliberately doesn't require their old one, since the whole point is they've forgotten it |
| Set or change someone's email | `PUT /api/users/:id` with `{ "email": "..." }` - same call as changing their role or name, just another field |
| Permanently delete an account | `DELETE /api/users/:id` |

`GET /api/users` includes a `pending_approval` count, so the UI can badge the
Users menu when someone is waiting.

**Deleting an account is permanent** - unlike employee/equipment/department/
software license, there's no recycle-bin snapshot for accounts (they're
credentials, not a business record with history worth restoring). Refused
with 409 in three cases:

| Situation | Why |
|---|---|
| Deleting your own account | This app re-validates credentials on every request, so deleting yourself would lock you out immediately, not on next login |
| The account is the only active admin | Same guard `PUT`'s role-change/deactivate path already has - nobody could manage the system afterward |
| The account issued or received a loan in part-borrow history | `part_borrow_record` has no name-snapshot column the way `borrow_record` does for a deleted employee, so there is no way to remove the account without permanently losing who issued or received that loan - deactivate it instead |

### Changing your own password

Not the admin reset above - any logged-in user, viewer or admin, changes
their own password:

```json
POST /api/auth/change-password
{ "current_password": "...", "new_password": "..." }
```

Requires `current_password` to match what's on file first (401 if it
doesn't) - unlike the admin reset, which skips that check because an admin
resetting someone else's forgotten password can't know it. Only ever acts on
the caller's own account: there's no `user_id` this endpoint reads from the
body or URL at all, so there's no way to reach anyone else's password
through it no matter what a request tries to send.

Password hashes are never returned by any user endpoint - the queries omit the
column rather than relying on the controller to strip it.

**Last-admin guard:** demoting or deactivating the only remaining active admin
is refused, since it would leave nobody able to manage the system.

### Password reset

For when a user can't log in at all, so `change-password` above (which
requires knowing the current password) doesn't help. Two public,
unauthenticated calls:

```json
POST /api/auth/forgot-password
{ "username": "somchai" }
```

`username` here accepts a real username or an email address, same as login.
The response is always the same, regardless of whether the account exists,
has no email on file, or was just throttled:

```json
{ "message": "If an account exists, a reset link has been sent." }
```

That's deliberate - the response itself must never be how someone finds out
which usernames or emails are registered. Behind that unchanging response,
a reset email only actually goes out when the account exists, is active, and
has an email address on file; otherwise the call quietly does nothing and
still returns the same message. Requests are throttled to 5 per hour per IP,
and even a throttled request gets the generic response rather than a 429 -
a distinct throttle response would itself leak information.

The email contains a link built from `FRONTEND_URL` (falls back to this
API's own `localhost:<PORT>` if unset) with a one-time token:

```
{FRONTEND_URL}/reset-password?token=<token>
```

The frontend reads `token` off that URL and submits it here along with the
new password:

```json
POST /api/auth/reset-password
{ "token": "...", "new_password": "..." }
```

Token security mirrors how passwords themselves are handled: the raw token
is only ever in the email and the frontend's URL - the database stores just
a SHA-256 hash of it, so a database leak alone can't be used to reset
anyone's password. A token expires 1 hour after it's issued and can only be
redeemed once; a second attempt with the same token, or an already-expired
one, is rejected with 400.

**No SMTP configured yet.** Without `SMTP_HOST`/`SMTP_USER`/`SMTP_PASSWORD`
set in `.env`, `utils/mailer.js` doesn't fail - it logs the would-be email
(subject and reset link included) to the server console instead, so the
whole flow is testable end to end before real email credentials exist. Set
those variables (see `.env.example`) to actually send mail.

## Endpoints

Grouped by domain. "Any user" means any authenticated account, viewer or admin.

<details><summary><b>Auth &amp; users</b></summary>

| Method | Endpoint | Access |
|---|---|---|
| POST | `/api/auth/login` | Public |
| POST | `/api/auth/signup` | Public |
| GET | `/api/auth/me` | Any user |
| POST | `/api/auth/change-password` | Any user - own account only |
| POST | `/api/auth/forgot-password` | Public |
| POST | `/api/auth/reset-password` | Public - authenticated by the token itself |
| POST | `/api/auth/register` | Admin |
| GET | `/api/users` | Admin |
| GET | `/api/users/:id` | Admin |
| PUT | `/api/users/:id` | Admin |
| POST | `/api/users/:id/reset-password` | Admin |
| DELETE | `/api/users/:id` | Admin |

</details>

<details><summary><b>Employees</b></summary>

| Method | Endpoint | Access |
|---|---|---|
| GET | `/api/employees/search?name=X` | Any user |
| GET | `/api/employees` | Any user |
| GET | `/api/employees/:id` | Any user |
| GET | `/api/employees/:id/full` | Any user |
| GET | `/api/employees/:id/replacements` | Any user |
| GET | `/api/employees/:id/part-replacements` | Any user |
| POST | `/api/employees` | Admin |
| PUT | `/api/employees/:id` | Any user |
| DELETE | `/api/employees/:id` | Any user |

</details>

<details><summary><b>Equipment</b></summary>

| Method | Endpoint | Access |
|---|---|---|
| GET | `/api/equipment` | Any user |
| GET | `/api/equipment/categories` | Any user |
| GET | `/api/equipment/licenses` | Any user |
| GET | `/api/equipment/licenses/:id/equipment` | Any user |
| GET | `/api/equipment/views` | Any user |
| POST | `/api/equipment/unassign` | Any user |
| GET | `/api/equipment/:id` | Any user |
| GET | `/api/equipment/:id/licenses` | Any user |
| POST | `/api/equipment/:id/licenses` | Admin |
| DELETE | `/api/equipment/:id/licenses/:licenseId` | Admin |
| GET | `/api/equipment/:id/part-replacements` | Any user |
| POST | `/api/equipment/:id/part-replacements` | Admin |
| DELETE | `/api/equipment/:id/part-replacements/:replacementId` | Admin |
| PUT | `/api/equipment/:id/owner` | Any user |
| PUT | `/api/equipment/:id` | Any user |
| DELETE | `/api/equipment/:id` | Admin |
| GET | `/api/equipment/:view` | Any user |
| POST | `/api/equipment/:view` | Admin |
| PUT | `/api/equipment/:view/:id` | Any user |

`:view` is a category's `view_key` (see View columns below) - the same
collection with per-category column configuration layered on top.

</details>

<details><summary><b>Stock &amp; assignment (equipment)</b></summary>

| Method | Endpoint | Access |
|---|---|---|
| POST | `/api/stock/add` | Admin |
| POST | `/api/stock/assign` | Any user |
| GET | `/api/stock/available` | Any user |
| GET | `/api/stock/by-date` | Any user |
| GET | `/api/assign/form-data` | Any user |
| GET | `/api/assign/available` | Any user |
| GET | `/api/assign/employees` | Any user |
| POST | `/api/assign` | Admin |

</details>

<details><summary><b>Departments, categories, statuses</b></summary>

| Method | Endpoint | Access |
|---|---|---|
| GET | `/api/departments` | Any user |
| GET | `/api/departments/:id` | Any user |
| POST | `/api/departments` | Admin |
| PUT | `/api/departments/:id` | Any user |
| DELETE | `/api/departments/:id` | Admin |
| GET | `/api/categories` | Any user |
| GET | `/api/categories/:id` | Any user |
| POST | `/api/categories` | Admin |
| PUT | `/api/categories/:id` | Any user |
| DELETE | `/api/categories/:id` | Admin |
| GET | `/api/statuses` | Any user |
| GET | `/api/statuses/:id` | Any user |
| POST | `/api/statuses` | Admin |
| PUT | `/api/statuses/:id` | Admin |
| DELETE | `/api/statuses/:id` | Admin |

</details>

<details><summary><b>Borrow &amp; return (equipment)</b></summary>

| Method | Endpoint | Access |
|---|---|---|
| GET | `/api/borrow/available` | Any user |
| GET | `/api/borrow/current` | Any user |
| GET | `/api/borrow/history` | Any user |
| GET | `/api/borrow/returns` | Any user |
| GET | `/api/borrow/borrower/:id` | Any user |
| GET | `/api/borrow/:id` | Any user |
| POST | `/api/borrow` | Any user |
| POST | `/api/borrow/return` | Any user |
| POST | `/api/borrow/:id/return` | Any user |

</details>

<details><summary><b>Custom fields &amp; view columns (equipment)</b></summary>

| Method | Endpoint | Access |
|---|---|---|
| GET | `/api/custom-fields/types` | Any user |
| GET | `/api/custom-fields` | Any user |
| GET | `/api/custom-fields/category/:categoryId` | Any user |
| POST | `/api/custom-fields` | Admin |
| PUT | `/api/custom-fields/:fieldId` | Admin |
| DELETE | `/api/custom-fields/:fieldId` | Admin |
| POST | `/api/custom-fields/category/:categoryId/attach` | Admin |
| DELETE | `/api/custom-fields/category/:categoryId/field/:fieldId` | Admin |
| GET | `/api/view-columns/available-fields` | Admin |
| GET | `/api/view-columns` | Admin |
| GET | `/api/view-columns/:categoryId` | Admin |
| PUT | `/api/view-columns/:categoryId` | Admin |

</details>

<details><summary><b>Parts - types, stock, statuses, custom fields</b></summary>

| Method | Endpoint | Access |
|---|---|---|
| GET | `/api/part-types` | Any user |
| GET | `/api/part-types/columns` | Admin |
| GET | `/api/part-types/stock-columns` | Admin |
| GET | `/api/part-types/:id/categories` | Admin |
| PUT | `/api/part-types/:id/categories` | Admin |
| GET | `/api/part-types/:id/stock-columns` | Any user |
| PUT | `/api/part-types/:id/stock-columns` | Admin |
| POST | `/api/part-types` | Admin |
| PUT | `/api/part-types/:id` | Admin |
| DELETE | `/api/part-types/:id` | Admin |
| GET | `/api/part-stock` | Any user |
| GET | `/api/part-stock/available` | Any user |
| GET | `/api/part-stock/summary` | Any user |
| POST | `/api/part-stock` | Admin |
| PUT | `/api/part-stock/:id` | Admin |
| DELETE | `/api/part-stock/:id` | Admin |
| GET | `/api/part-statuses` | Any user |
| GET | `/api/part-statuses/:id` | Any user |
| POST | `/api/part-statuses` | Admin |
| PUT | `/api/part-statuses/:id` | Admin |
| DELETE | `/api/part-statuses/:id` | Admin |
| GET | `/api/part-custom-fields/types` | Any user |
| GET | `/api/part-custom-fields` | Any user |
| GET | `/api/part-custom-fields/part-type/:partTypeId` | Any user |
| POST | `/api/part-custom-fields` | Admin |
| PUT | `/api/part-custom-fields/:fieldId` | Admin |
| DELETE | `/api/part-custom-fields/:fieldId` | Admin |
| POST | `/api/part-custom-fields/part-type/:partTypeId/attach` | Admin |
| DELETE | `/api/part-custom-fields/part-type/:partTypeId/field/:fieldId` | Admin |
| GET | `/api/part-replacements` | Any user |

</details>

<details><summary><b>Borrowing loose parts</b></summary>

| Method | Endpoint | Access |
|---|---|---|
| GET | `/api/part-borrow/available` | Any user |
| GET | `/api/part-borrow/current` | Any user |
| GET | `/api/part-borrow/history` | Any user |
| GET | `/api/part-borrow/returns` | Any user |
| GET | `/api/part-borrow/borrower/:id` | Any user |
| GET | `/api/part-borrow/:id` | Any user |
| POST | `/api/part-borrow` | Any user |
| POST | `/api/part-borrow/:id/return` | Any user |
| DELETE | `/api/part-borrow/:id` | Admin |

</details>

<details><summary><b>Software licenses, server usage, antivirus, device replacement</b></summary>

| Method | Endpoint | Access |
|---|---|---|
| GET | `/api/licenses` | Any user |
| POST | `/api/licenses` | Admin |
| PUT | `/api/licenses/:id` | Admin |
| DELETE | `/api/licenses/:id` | Admin |
| GET | `/api/server-usage` | Any user |
| POST | `/api/server-usage` | Admin |
| PATCH | `/api/server-usage/equipment/:id/usage` | Any user |
| DELETE | `/api/server-usage/:id` | Admin |
| GET | `/api/antivirus` | Any user |
| POST | `/api/antivirus` | Admin |
| PUT | `/api/antivirus/:id` | Admin |
| DELETE | `/api/antivirus/:id` | Admin |
| GET | `/api/replacements` | Any user |

</details>

<details><summary><b>Recycle bin, audit log, reports, search</b></summary>

| Method | Endpoint | Access |
|---|---|---|
| GET | `/api/recycle-bin` | Admin |
| GET | `/api/recycle-bin/:id` | Admin |
| POST | `/api/recycle-bin/:id/restore` | Admin |
| DELETE | `/api/recycle-bin/:id` | Admin |
| DELETE | `/api/recycle-bin/purge-all` | Admin |
| GET | `/api/audit?limit=200` | Admin |
| GET | `/api/reports/equipment` | Any user |
| GET | `/api/reports/employees` | Any user |
| GET | `/api/reports/borrow-history` | Any user |
| GET | `/api/reports/part-stock` | Any user |
| GET | `/api/search?q=X` | Any user |
| GET | `/api/filters` | Any user |

</details>

## Editing and deleting

### Audit log

Successful updates and deletes are recorded with the acting account, action,
record type and ID, submitted changes, and time - `middleware/auditActivity.js`,
applied per-route. Administrators read it from `GET /api/audit?limit=200`.

Authenticated non-admin users may update or delete employees, equipment details,
departments, and categories, and may unassign equipment before deleting a staff
member. Creating records, assigning equipment, stock actions, borrowing/returns,
and user-account management remain admin-only.

**Deletable (authenticated users, all guarded):** employees, departments, categories.

**Deletable, admin-only:** equipment - `DELETE /api/equipment/:id` exists, but is
meant for correcting a mistaken entry, not for retiring a real device. It's
guarded the same way as the rest: refused with 409 while any borrow record,
antivirus record, server usage entry, or part replacement still references
it, which in practice means anything with real usage history can't be
deleted through this endpoint at all. Retire a real device instead - `PUT`
with `status: "Retired - IT Stock"` - which keeps its history and is what the
409's own `hint` field suggests.

**Not deletable at all:** borrow records. There's no endpoint for it - a loan
is either open or returned, never erased.

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

A delete that does go through is captured to the **recycle bin** first (see
below), not gone outright - it can be restored later if it turns out to have
been a mistake.

### Employees who leave

Deleting them is the wrong tool. `borrow_record.borrower_id` is nullable
specifically so a deletion doesn't have to be blocked by loan history - the
borrower's name is snapshotted onto the loan (`borrower_name`) and the id
cleared, so "someone borrowed the projector and never returned it" stays a
readable record even after the person is gone.

Deactivate instead, though, when the goal is day-to-day housekeeping rather
than a genuine data cleanup:

```json
PUT /api/employees/:id
{ "is_active": false, "left_date": "2026-07-30" }
```

They vanish from `GET /api/employees` (and so from every assign and borrow
dropdown), but their history stays intact and still resolves to a real name.
Use `?include_inactive=true` to see them again.

**Edit equipment** - `PUT /api/equipment/:id` (or `/api/equipment/:view/:id`).
Send only the fields that change; anything omitted is left alone. Accepts
`category` / `department` as name or id. Rejects an asset code or service tag
that would clash with another record.

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

**For the frontend:** `GET /api/statuses` returns all of these with `is_assignable`
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

## Custom fields (equipment)

Category-specific attributes that don't warrant a real column on
`dbo.equipment` - "Warranty End" on Laptops, say. A field is defined once
(`equipment_custom_field`) and attached to whichever categories use it
(`equipment_category_field`), so the same field is never redefined twice for
two categories that happen to want the same attribute.

```json
POST /api/custom-fields                                    (admin)
{ "fieldLabel": "Warranty End", "fieldType": "date" }

POST /api/custom-fields/category/4/attach                  (admin)
{ "fieldId": 7, "sortOrder": 1, "isRequired": false }
```

`fieldType` is one of `text`, `number`, `date`, `boolean`. Values are always
stored as text underneath - the type drives the frontend's input control and
validation, not a differently-typed column, so adding a field a category
gains later needs no migration.

Values ride alongside the normal equipment create/update calls - any body key
matching an attached field's `field_key` is saved automatically, no separate
endpoint needed for the common case. `GET /api/equipment/:id` returns them
inline.

**View columns** (`/api/view-columns`) are the companion piece: which of a
category's fields (built-in or custom) actually show up as a column on that
category's equipment table, and in what order. Configuring this is what makes
`GET /api/equipment/:view` return a genuinely different shape per category
(a Laptop's table looks different from a Server's) without any client-side
per-category logic.

## Parts (spare-part inventory)

Separate from equipment: `dbo.equipment` is what a device *is*, this is what's
on the shelf to fit into one - RAM, storage, batteries, or a model-identified
accessory like a mouse or bag.

**Part types** (`/api/part-types`) define what kinds of part exist. Two
attributes decide how a type behaves everywhere else in this system:

| Field | Meaning |
|---|---|
| `tracks_value` | Identified by a value ("16 GB") vs. a model (`model_name`/`model_number`) |
| `is_countable` | Can quantities accumulate on a device (`'add'` action), or only ever get replaced whole |

A part type can optionally map to a real `dbo.equipment` column
(`equipment_column: "ram"`) or a custom field key, so fitting it updates the
device's own record automatically - see Part replacements below.

**Part statuses** (`/api/part-statuses`) mirror equipment's own status system,
one level down - a real reference table, not free text, but without
`is_assignable` (parts aren't assigned to a person, only borrowed):

| Status | Meaning | Borrowable |
|---|---|---|
| `Working - IT Stock` | On the shelf, working | **Yes** |
| `Broken - IT Stock` | Not usable | No |
| `Working/Using` | Still good, already earmarked for something else | No |

**Stock** (`/api/part-stock`) is counted, not individually identified - "3 x
8GB RAM working" rather than tracking each stick with its own code. Working
and broken stock of the same part are separate lines, so a faulty module is
never offered for fitting.

```json
POST /api/part-stock                                       (admin)
{ "part_type_id": 3, "part_value": "16", "status": "Working - IT Stock", "quantity": 4 }
```

**Part custom fields** (`/api/part-custom-fields`) and **stock columns**
(`/api/part-types/:id/stock-columns`) are the parts-side equivalents of
equipment's custom fields and view columns - kept as entirely separate tables
from their equipment counterparts, since a device attribute and a spare-part
attribute are never meant to be the same field even when the name matches.

### Part replacements

Fitting a part from stock onto a device, or undoing that:

```json
POST /api/equipment/:id/part-replacements                  (admin)
{ "part_type_id": 3, "action": "replace", "from_stock_id": 41, "new_value": "16" }
```

`action` is `replace`, `add` (only for `is_countable` types - sums onto the
current value), or `remove` (nothing fitted, only taken out). The part
leaving stock is decremented atomically with the history row and, when the
part type maps to a real column or custom field, the device's own record -
so stock counts, device specs and replacement history can never drift apart.

`DELETE /api/equipment/:id/part-replacements/:replacementId` (admin) undoes
one: restores the device's prior value, and returns the fitted part to
stock. `add` actions can't be undone - once several adds have stacked,
there's no single "before" value to restore to.

Reading the history: `GET /api/equipment/:id/part-replacements` for one
device, `GET /api/employees/:id/part-replacements` for everything across an
employee's whole kit, `GET /api/part-replacements` for every replacement
ever logged.

## Software licenses

`/api/licenses` - what's licensed, and which devices it's installed on
(many-to-many via `equipment_software_license`).

```json
POST /api/licenses                                         (admin)
{ "product_name": "Office 365", "product_type": "Software",
  "license_type": "Annual Subscription", "date_expire": "2027-01-01" }
```

`license_type` is `Free`, `Perpetual`, or `Annual Subscription`. Status
(`active` / `near expire` / `expired` / `unknown`) is always computed, never
set directly - `active`/`Perpetual` are always active; an Annual Subscription
is `near expire` inside one month of `date_expire`, `expired` past it. The
same rule runs both at write time and on every read, so a license's status
never disagrees with itself between "what was just saved" and "what the list
shows."

**Attaching a license to a device** is separate from creating the license
record itself:

```json
GET /api/equipment/:id/licenses                             (any user - what's on this device)
POST /api/equipment/:id/licenses         { "license_id": 12 }  (admin)
DELETE /api/equipment/:id/licenses/:licenseId                (admin)
```

`GET /api/equipment/licenses/:id/equipment` is the reverse lookup: which
devices hold a given license, for answering "we have 50 seats - how many are
used, and by whom?"

## Server usage

`/api/server-usage` - the capacity-planning sheet (Total Capacity vs. Usage)
for Server-category equipment. Deliberately separate from `dbo.equipment`:
that table stores what a server *is* (its CPU/RAM/HD, which this reads
directly, never duplicating it), this table stores what to *do* about its
capacity.

**It's a history log, not one row per server** - every save adds a new row
rather than overwriting the last one, so "what was this server's load as of a
given date" stays answerable later.

- `GET /api/server-usage` - today's view: every Server-category device, its
  single latest entry (blank if none yet, so a server nobody has filled in
  still shows up to prompt someone to).
- `GET /api/server-usage?from=2026-01-01&to=2026-01-31` - the calendar view
  instead: every entry actually recorded in that range. A server edited twice
  in the window returns two rows; a server untouched in it doesn't appear at
  all - a log of what happened, not "every server, blank or not."
- `PATCH /api/server-usage/equipment/:id/usage` - the self-service form, open
  to **any signed-in user**, not just admins (unlike the admin-only `POST`
  above). Deliberately narrow: only `cpu_usage_pct`, `memory_usage_pct`,
  `hdd_usage_gb` - never capacity, due date, owner, or remark. A field left
  out of a call carries forward from the most recent entry rather than
  blanking out, and a bare number like `"45"` gets `%` appended automatically.

## Antivirus tracking

`/api/antivirus` - per-device install status, plan/due/completed dates. A
device can legitimately have more than one install record over time
(reinstalled after a wipe, say) - reads that need "the current one" always
pick the most recent by install date, not just any row.

## Device replacement

`/api/replacements` - whole-device swaps (this laptop for that one), distinct
from **part** replacements above (a component swapped inside the same
device). Records the employee, the old and new equipment, and condition/
location notes on both sides at the time of the swap.

## Recycle bin

Deleting an employee, equipment, department, or software license captures a
full snapshot to `dbo.recycle_bin` first, in the same transaction as the
delete itself - so a failed delete can't leave an orphaned bin entry, and a
failed bin write can't lose the record. (Category deletion does not currently
go through the bin, even though `category` is one of the types `restore()`
knows how to put back - worth wiring up if categories start getting deleted
in practice.)

```json
GET /api/recycle-bin?entity_type=employee                  (admin)
POST /api/recycle-bin/42/restore                           (admin)
DELETE /api/recycle-bin/42                                 (admin, permanent)
DELETE /api/recycle-bin/purge-all?confirm=true              (admin, empties everything)
```

**Restoring puts the row back at its original id** (an `IDENTITY_INSERT`
operation - the one place in this app that still has to be raw SQL, since no
ORM can force a value into an auto-increment primary key), so anything that
already referenced it - a borrow record, say - doesn't end up pointing at
nothing. Refused when: already restored, the id has since been taken by
something else, or none of the stored columns still exist on the table
(schema changed since the delete).

## Reports

`/api/reports/*` - equipment, employees, borrow history, and part stock,
exported as a file download for anyone who needs the data outside the API
itself. `?format=xlsx` (the default, via `exceljs`) or `?format=pdf` (via
`pdfkit`, hand-drawn table layout since pdfkit has no table primitive of its
own) - any other value is rejected with a 400 listing the two valid ones.
