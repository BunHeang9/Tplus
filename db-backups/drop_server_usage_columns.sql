-- Run this with an account that has ALTER/DDL rights on the database
-- (the app's own login does not - it's DML-only: SELECT/INSERT/UPDATE/DELETE).
--
-- Removes plan_date and the reducing/after-reducing columns from
-- dbo.server_usage. due_date is kept - only these 5 are being dropped.
--
-- Only usage_id 47 had any non-NULL data in these columns (reducing_cpu_core
-- = 1); it's backed up in db-backups/server_usage_dropped_columns_export.sql
-- before running this.

ALTER TABLE dbo.server_usage DROP COLUMN plan_date;
ALTER TABLE dbo.server_usage DROP COLUMN reducing_cpu_core;
ALTER TABLE dbo.server_usage DROP COLUMN reducing_memory_gb;
ALTER TABLE dbo.server_usage DROP COLUMN after_reducing_cpu_core;
ALTER TABLE dbo.server_usage DROP COLUMN after_reducing_memory_gb;
