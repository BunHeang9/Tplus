-- Adds a third allowed value ('Working/Using') to dbo.part_stock.status.
--
-- Currently chk_stock_status only allows 'Working - IT Stock' and
-- 'Broken - IT Stock'. This is for a part that comes out of one device but
-- is still good and already going straight into another device, rather than
-- sitting on the shelf as generic available stock.
--
-- Run this as a login with ALTER permission on dbo.part_stock - the app's
-- own DB login only has SELECT/INSERT/UPDATE/DELETE, confirmed by testing
-- an INSERT with status = 'Working/Using' and getting a CHECK constraint
-- violation back.
--
-- Safe to run more than once: DROP CONSTRAINT IF EXISTS + CREATE, not
-- destructive to any data - part_stock rows and their existing statuses
-- are untouched either way.

BEGIN TRANSACTION;

IF EXISTS (
    SELECT 1 FROM sys.check_constraints
    WHERE name = 'chk_stock_status' AND parent_object_id = OBJECT_ID('dbo.part_stock')
)
    ALTER TABLE dbo.part_stock DROP CONSTRAINT chk_stock_status;

ALTER TABLE dbo.part_stock
    ADD CONSTRAINT chk_stock_status
    CHECK (status IN ('Working - IT Stock', 'Broken - IT Stock', 'Working/Using'));

COMMIT TRANSACTION;

-- Verify afterwards:
-- INSERT INTO dbo.part_stock (part_type_id, status, quantity)
--   VALUES ((SELECT TOP 1 part_type_id FROM dbo.part_type), 'Working/Using', 0);
-- (then delete that test row)
