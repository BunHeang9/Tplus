-- Adds email + password-reset token storage to dbo.api_user.
--
-- One outstanding reset token per account (not a separate table) -
-- requesting a new reset link invalidates whatever the previous one was,
-- which is standard behavior and keeps this to two extra columns instead of
-- a whole new table. reset_token_hash stores a SHA-256 hash, never the raw
-- token itself - same reasoning as password_hash: if this table ever
-- leaked, a raw token would let someone take over the matching account
-- immediately, a hash does not.
--
-- Run this once, manually - the app's own DB login has no ALTER permission
-- (same as every other schema change in this project, see db-backups/ and
-- the rest of migrations/).

ALTER TABLE dbo.api_user ADD email VARCHAR(255) NULL;
ALTER TABLE dbo.api_user ADD reset_token_hash VARCHAR(64) NULL;
ALTER TABLE dbo.api_user ADD reset_token_expires_at DATETIME NULL;
