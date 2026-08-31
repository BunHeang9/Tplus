-- Run this with an account that has ALTER/DDL rights on the database
-- (the app's own login does not - it's DML-only: SELECT/INSERT/UPDATE/DELETE).
--
-- Data for all four tables is already backed up in
-- db-backups/deleted_features_export.sql before running this.

DROP TABLE dbo.cloud_rate;
DROP TABLE dbo.cloud_usage;
DROP TABLE dbo.ssd_upgrade;
DROP TABLE dbo.ssd_procurement;
