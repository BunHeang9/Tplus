-- Backup of the 5 dropped dbo.server_usage columns (plan_date, reducing_cpu_core,
-- reducing_memory_gb, after_reducing_cpu_core, after_reducing_memory_gb),
-- taken 2026-08-31T02:29:44.880Z. Only rows with non-NULL data in any of
-- them are included (the rest were already empty). To restore a value: run
-- the ALTER TABLE ADD COLUMN for it, then these UPDATEs.

-- 1 row(s) had data in these columns:
-- usage_id 47: plan_date=NULL, reducing_cpu_core=1, reducing_memory_gb=NULL, after_reducing_cpu_core=NULL, after_reducing_memory_gb=NULL
UPDATE dbo.server_usage SET plan_date = NULL, reducing_cpu_core = 1, reducing_memory_gb = NULL, after_reducing_cpu_core = NULL, after_reducing_memory_gb = NULL WHERE usage_id = 47;
