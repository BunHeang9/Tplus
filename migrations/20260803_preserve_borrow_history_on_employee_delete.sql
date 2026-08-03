/*
  Preserve borrow-history names after a physical employee deletion.

  Run this once against the Tplus database before deploying the matching API
  code. It snapshots existing names, allows the employee links to be NULL, and
  keeps their foreign keys non-cascading. The API clears employee IDs in the
  same transaction as deletion, avoiding SQL Server's multiple-cascade-path rule.
*/
SET XACT_ABORT ON;
BEGIN TRANSACTION;

IF COL_LENGTH('dbo.borrow_record', 'borrower_name') IS NULL
  ALTER TABLE dbo.borrow_record ADD borrower_name NVARCHAR(255) NULL;
IF COL_LENGTH('dbo.borrow_record', 'issued_by_name') IS NULL
  ALTER TABLE dbo.borrow_record ADD issued_by_name NVARCHAR(255) NULL;
IF COL_LENGTH('dbo.borrow_record', 'received_by_name') IS NULL
  ALTER TABLE dbo.borrow_record ADD received_by_name NVARCHAR(255) NULL;

-- `GO` makes SSMS compile the next batch against the altered table definition.
GO

UPDATE b
SET borrower_name = COALESCE(b.borrower_name, borrower.full_name),
    issued_by_name = COALESCE(b.issued_by_name, issuer.full_name),
    received_by_name = COALESCE(b.received_by_name, receiver.full_name)
FROM dbo.borrow_record b
LEFT JOIN dbo.employee borrower ON borrower.employee_id = b.borrower_id
LEFT JOIN dbo.employee issuer ON issuer.employee_id = b.issued_by_id
LEFT JOIN dbo.employee receiver ON receiver.employee_id = b.received_by_id;

DECLARE @sql NVARCHAR(MAX) = N'';
SELECT @sql += N'ALTER TABLE dbo.borrow_record DROP CONSTRAINT ' + QUOTENAME(fk.name) + N';' + CHAR(10)
FROM sys.foreign_keys fk
WHERE fk.parent_object_id = OBJECT_ID(N'dbo.borrow_record')
  AND fk.referenced_object_id = OBJECT_ID(N'dbo.employee');
EXEC sp_executesql @sql;

ALTER TABLE dbo.borrow_record ALTER COLUMN borrower_id INT NULL;
ALTER TABLE dbo.borrow_record ALTER COLUMN issued_by_id INT NULL;
ALTER TABLE dbo.borrow_record ALTER COLUMN received_by_id INT NULL;

ALTER TABLE dbo.borrow_record WITH CHECK ADD CONSTRAINT FK_borrow_record_borrower
  FOREIGN KEY (borrower_id) REFERENCES dbo.employee(employee_id) ON DELETE NO ACTION;
ALTER TABLE dbo.borrow_record WITH CHECK ADD CONSTRAINT FK_borrow_record_issued_by
  FOREIGN KEY (issued_by_id) REFERENCES dbo.employee(employee_id) ON DELETE NO ACTION;
ALTER TABLE dbo.borrow_record WITH CHECK ADD CONSTRAINT FK_borrow_record_received_by
  FOREIGN KEY (received_by_id) REFERENCES dbo.employee(employee_id) ON DELETE NO ACTION;

COMMIT TRANSACTION;
