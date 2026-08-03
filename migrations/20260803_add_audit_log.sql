IF OBJECT_ID(N'dbo.audit_log', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.audit_log (
    audit_id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    actor_user_id INT NULL,
    actor_username NVARCHAR(255) NOT NULL,
    actor_name NVARCHAR(255) NULL,
    actor_role VARCHAR(50) NOT NULL,
    action VARCHAR(20) NOT NULL,
    entity_type VARCHAR(50) NOT NULL,
    entity_id NVARCHAR(100) NULL,
    request_path NVARCHAR(500) NOT NULL,
    change_data NVARCHAR(MAX) NULL,
    created_at DATETIME2 NOT NULL CONSTRAINT DF_audit_log_created_at DEFAULT SYSUTCDATETIME()
  );

  CREATE INDEX IX_audit_log_created_at ON dbo.audit_log (created_at DESC, audit_id DESC);
END;
