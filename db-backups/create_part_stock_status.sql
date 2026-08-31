-- Creates a real, manageable status table for spare parts (dbo.part_stock),
-- matching how dbo.equipment_status already works for equipment - admin can
-- add/edit/remove part statuses from the app afterward instead of needing a
-- code change + another one of these scripts.
--
-- part_stock.status becomes a real foreign key straight to this table's
-- status_name (not a separate status_id + denormalized text pair the way
-- equipment does it), with ON UPDATE CASCADE - renaming a status later
-- automatically updates every part_stock row using it, no app code involved.
--
-- Run this as a login with CREATE TABLE / ALTER TABLE permission - the
-- app's own DB login only has SELECT/INSERT/UPDATE/DELETE (same limit as
-- every other DDL script in db-backups/).
--
-- Safe to run more than once: every step is guarded with an IF NOT EXISTS/
-- IF EXISTS check first.

BEGIN TRANSACTION;

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'part_stock_status' AND schema_id = SCHEMA_ID('dbo'))
BEGIN
    CREATE TABLE dbo.part_stock_status (
        status_id     INT IDENTITY(1,1) PRIMARY KEY,
        status_name   VARCHAR(50)  NOT NULL,
        description   VARCHAR(255) NULL,
        is_borrowable BIT          NOT NULL DEFAULT 0,
        sort_order    INT          NOT NULL DEFAULT 99,
        is_active     BIT          NOT NULL DEFAULT 1,
        created_at    DATETIME     NOT NULL DEFAULT GETDATE(),
        CONSTRAINT uq_part_stock_status_name UNIQUE (status_name)
    );
END;

-- Seed the 3 statuses already in use, if they aren't there yet.
IF NOT EXISTS (SELECT 1 FROM dbo.part_stock_status WHERE status_name = 'Working - IT Stock')
    INSERT INTO dbo.part_stock_status (status_name, description, is_borrowable, sort_order)
    VALUES ('Working - IT Stock', 'On the shelf and working - available to fit or borrow', 1, 1);

IF NOT EXISTS (SELECT 1 FROM dbo.part_stock_status WHERE status_name = 'Broken - IT Stock')
    INSERT INTO dbo.part_stock_status (status_name, description, is_borrowable, sort_order)
    VALUES ('Broken - IT Stock', 'Not usable', 0, 2);

IF NOT EXISTS (SELECT 1 FROM dbo.part_stock_status WHERE status_name = 'Working/Using')
    INSERT INTO dbo.part_stock_status (status_name, description, is_borrowable, sort_order)
    VALUES ('Working/Using', 'Still good, already earmarked for a different device - not offered as free stock', 0, 3);

-- Drop the old fixed CHECK constraint (only allowed exactly 2 values,
-- hardcoded) and replace it with a real foreign key to the new table.
IF EXISTS (
    SELECT 1 FROM sys.check_constraints
    WHERE name = 'chk_stock_status' AND parent_object_id = OBJECT_ID('dbo.part_stock')
)
    ALTER TABLE dbo.part_stock DROP CONSTRAINT chk_stock_status;

IF NOT EXISTS (
    SELECT 1 FROM sys.foreign_keys
    WHERE name = 'fk_part_stock_status' AND parent_object_id = OBJECT_ID('dbo.part_stock')
)
    ALTER TABLE dbo.part_stock
        ADD CONSTRAINT fk_part_stock_status
        FOREIGN KEY (status) REFERENCES dbo.part_stock_status(status_name)
        ON UPDATE CASCADE;

COMMIT TRANSACTION;

-- Verify afterwards:
-- SELECT * FROM dbo.part_stock_status ORDER BY sort_order;
