# Tests

Run with `npm test` (or `npm run test:watch` while writing new ones).

## No separate test database

`config/sequelize.js` points at one database (`DB_DATABASE` in `.env`) - there
is no `Tplus_test` or equivalent. Any test that needs the database runs
against the same one the app itself uses.

That means: **a test may only ever create and delete its own scratch rows**
(a `TEST-...`-prefixed name is the convention used throughout this project's
verification history) and must **never** modify, delete, or depend on the
existence of a real employee/equipment/license/etc. record. Clean up in a
`finally`/`afterAll` so a failed assertion doesn't leave scratch rows behind.

Prefer pure-function tests (no DB) wherever the logic allows it - see
`utils/licenseStatus.js` and its test for the pattern: business rules with
real edge cases (date math, status computation) pulled out of a DB-coupled
model file into their own dependency-free module, specifically so they can
be tested in milliseconds without a connection.

## Why this exists

Every conversion in the `sequelize-migration` branch's raw-SQL-to-ORM sweep
was verified with a one-off script, run once, then deleted - real rigor that
didn't survive in the repo. The tests here are the ones judged worth keeping
permanently, starting with a regression test for a bug ultrareview actually
found (`tests/utils/licenseStatus.test.js`) - proof this approach catches
real things, not just process for its own sake.
