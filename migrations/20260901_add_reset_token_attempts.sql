-- Follow-up to 20260901_add_password_reset_columns.sql: the reset flow
-- changed from an emailed link (a 32-byte token, effectively unguessable)
-- to an emailed 6-digit code (only 1,000,000 possibilities), so a wrong
-- guess must now be counted and capped or the code is brute-forceable
-- within its expiry window.
ALTER TABLE dbo.api_user ADD reset_token_attempts INT NOT NULL DEFAULT 0;
