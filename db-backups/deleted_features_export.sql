-- Full export of 4 tables before dropping them, taken 2026-08-31T02:16:09.713Z.
-- Removed at the boss's request - cloud rate/usage tracking and SSD upgrade/procurement
-- pages are no longer needed. To restore any of these: run the CREATE TABLE for it
-- first (see schema below), then these INSERTs.

-- Schema for dbo.cloud_rate:
--   rate_id int NOT NULL IDENTITY PRIMARY KEY
--   item_name varchar(30) NOT NULL
--   unit varchar(10) NULL
--   capacity decimal(12,2) NULL
--   price_type varchar(10) NULL
--   unit_price decimal(12,2) NULL
--   total_price_month decimal(14,2) NULL
--   total_price_year decimal(14,2) NULL
--   year int NULL

-- dbo.cloud_rate: 8 rows
INSERT INTO dbo.cloud_rate ([rate_id], [item_name], [unit], [capacity], [price_type], [unit_price], [total_price_month], [total_price_year], [year]) VALUES (1, 'CPU', 'core', 460, 'Existing', 32000, 14720000, 176640000, 2024);
INSERT INTO dbo.cloud_rate ([rate_id], [item_name], [unit], [capacity], [price_type], [unit_price], [total_price_month], [total_price_year], [year]) VALUES (2, 'Memory', 'GB', 911, 'Existing', 6000, 5466000, 65592000, 2024);
INSERT INTO dbo.cloud_rate ([rate_id], [item_name], [unit], [capacity], [price_type], [unit_price], [total_price_month], [total_price_year], [year]) VALUES (3, 'HDD', 'GB', 97422, 'Existing', 300, 29226600, 350719200, 2024);
INSERT INTO dbo.cloud_rate ([rate_id], [item_name], [unit], [capacity], [price_type], [unit_price], [total_price_month], [total_price_year], [year]) VALUES (4, 'IP Addresses', 'IP', 59, 'Existing', 50000, 2950000, 35400000, 2024);
INSERT INTO dbo.cloud_rate ([rate_id], [item_name], [unit], [capacity], [price_type], [unit_price], [total_price_month], [total_price_year], [year]) VALUES (5, 'CPU', 'core', 460, 'New', 80000, 36800000, 441600000, 2025);
INSERT INTO dbo.cloud_rate ([rate_id], [item_name], [unit], [capacity], [price_type], [unit_price], [total_price_month], [total_price_year], [year]) VALUES (6, 'Memory', 'GB', 911, 'New', 40000, 36440000, 437280000, 2025);
INSERT INTO dbo.cloud_rate ([rate_id], [item_name], [unit], [capacity], [price_type], [unit_price], [total_price_month], [total_price_year], [year]) VALUES (7, 'HDD', 'GB', 97422, 'New', 2000, 194844000, 2338128000, 2025);
INSERT INTO dbo.cloud_rate ([rate_id], [item_name], [unit], [capacity], [price_type], [unit_price], [total_price_month], [total_price_year], [year]) VALUES (8, 'IP Addresses', 'IP', 59, 'New', 100000, 5900000, 70800000, 2025);

-- Schema for dbo.cloud_usage:
--   usage_id int NOT NULL IDENTITY PRIMARY KEY
--   item_name varchar(30) NOT NULL
--   unit varchar(10) NULL
--   unit_cost decimal(12,2) NULL
--   usage_month char(7) NULL
--   quantity decimal(12,2) NULL
--   amount decimal(14,2) NULL

-- dbo.cloud_usage: 4 rows
INSERT INTO dbo.cloud_usage ([usage_id], [item_name], [unit], [unit_cost], [usage_month], [quantity], [amount]) VALUES (1, 'CPU', 'core', 32000, '2024-12', 460, 14720000);
INSERT INTO dbo.cloud_usage ([usage_id], [item_name], [unit], [unit_cost], [usage_month], [quantity], [amount]) VALUES (2, 'Memory', 'GB', 6000, '2024-12', 911, 5466000);
INSERT INTO dbo.cloud_usage ([usage_id], [item_name], [unit], [unit_cost], [usage_month], [quantity], [amount]) VALUES (3, 'HDD', 'GB', 300, '2024-12', 97422, 29226600);
INSERT INTO dbo.cloud_usage ([usage_id], [item_name], [unit], [unit_cost], [usage_month], [quantity], [amount]) VALUES (4, 'IP Addresses', 'IP', 50000, '2024-11', 55, 2750000);

-- Schema for dbo.ssd_upgrade:
--   upgrade_id int NOT NULL IDENTITY PRIMARY KEY
--   employee_id int NOT NULL
--   equipment_id int NOT NULL
--   charge_cable_needed bit NULL
--   replace_status varchar(20) NULL
--   ssd_capacity varchar(20) NULL
--   ssd_equipment_code varchar(30) NULL
--   remark varchar(255) NULL

-- dbo.ssd_upgrade: 21 rows
INSERT INTO dbo.ssd_upgrade ([upgrade_id], [employee_id], [equipment_id], [charge_cable_needed], [replace_status], [ssd_capacity], [ssd_equipment_code], [remark]) VALUES (1, 1, 1, 0, 'Done', '128 GB', 'ITSW0044', 'to solve Antivirus new version; to solve performance');
INSERT INTO dbo.ssd_upgrade ([upgrade_id], [employee_id], [equipment_id], [charge_cable_needed], [replace_status], [ssd_capacity], [ssd_equipment_code], [remark]) VALUES (2, 2, 388, 0, 'Done', '128 GB', 'ITSW0052', NULL);
INSERT INTO dbo.ssd_upgrade ([upgrade_id], [employee_id], [equipment_id], [charge_cable_needed], [replace_status], [ssd_capacity], [ssd_equipment_code], [remark]) VALUES (3, 3, 3, 0, 'Done', '128 GB', 'ITSW0048', NULL);
INSERT INTO dbo.ssd_upgrade ([upgrade_id], [employee_id], [equipment_id], [charge_cable_needed], [replace_status], [ssd_capacity], [ssd_equipment_code], [remark]) VALUES (4, 82, 4, 0, 'Done', '128 GB', 'ITSW0045', NULL);
INSERT INTO dbo.ssd_upgrade ([upgrade_id], [employee_id], [equipment_id], [charge_cable_needed], [replace_status], [ssd_capacity], [ssd_equipment_code], [remark]) VALUES (5, 5, 5, 0, 'Done', '128 GB', 'ITSW0060', NULL);
INSERT INTO dbo.ssd_upgrade ([upgrade_id], [employee_id], [equipment_id], [charge_cable_needed], [replace_status], [ssd_capacity], [ssd_equipment_code], [remark]) VALUES (6, 6, 6, 0, NULL, '128 GB', NULL, NULL);
INSERT INTO dbo.ssd_upgrade ([upgrade_id], [employee_id], [equipment_id], [charge_cable_needed], [replace_status], [ssd_capacity], [ssd_equipment_code], [remark]) VALUES (7, 7, 7, 0, 'Done', '128 GB', 'ITSW0051', NULL);
INSERT INTO dbo.ssd_upgrade ([upgrade_id], [employee_id], [equipment_id], [charge_cable_needed], [replace_status], [ssd_capacity], [ssd_equipment_code], [remark]) VALUES (8, 8, 8, 0, 'Done', '128 GB', 'ITSW0046', NULL);
INSERT INTO dbo.ssd_upgrade ([upgrade_id], [employee_id], [equipment_id], [charge_cable_needed], [replace_status], [ssd_capacity], [ssd_equipment_code], [remark]) VALUES (9, 9, 9, 0, 'Done', '128 GB', 'ITSW0055', NULL);
INSERT INTO dbo.ssd_upgrade ([upgrade_id], [employee_id], [equipment_id], [charge_cable_needed], [replace_status], [ssd_capacity], [ssd_equipment_code], [remark]) VALUES (10, 10, 10, 0, 'Done', '128 GB', 'ITSW0063', NULL);
INSERT INTO dbo.ssd_upgrade ([upgrade_id], [employee_id], [equipment_id], [charge_cable_needed], [replace_status], [ssd_capacity], [ssd_equipment_code], [remark]) VALUES (11, 11, 11, 0, 'Done', '128 GB', 'ITSW0053', NULL);
INSERT INTO dbo.ssd_upgrade ([upgrade_id], [employee_id], [equipment_id], [charge_cable_needed], [replace_status], [ssd_capacity], [ssd_equipment_code], [remark]) VALUES (12, 12, 12, 0, NULL, '128 GB', NULL, NULL);
INSERT INTO dbo.ssd_upgrade ([upgrade_id], [employee_id], [equipment_id], [charge_cable_needed], [replace_status], [ssd_capacity], [ssd_equipment_code], [remark]) VALUES (13, 13, 13, 0, 'Done', '128 GB', 'ITSW0047', NULL);
INSERT INTO dbo.ssd_upgrade ([upgrade_id], [employee_id], [equipment_id], [charge_cable_needed], [replace_status], [ssd_capacity], [ssd_equipment_code], [remark]) VALUES (14, 14, 14, 0, 'Done', '128 GB', 'ITSW0050', NULL);
INSERT INTO dbo.ssd_upgrade ([upgrade_id], [employee_id], [equipment_id], [charge_cable_needed], [replace_status], [ssd_capacity], [ssd_equipment_code], [remark]) VALUES (15, 15, 786, 0, 'Done', '128 GB', 'ITSW0056', NULL);
INSERT INTO dbo.ssd_upgrade ([upgrade_id], [employee_id], [equipment_id], [charge_cable_needed], [replace_status], [ssd_capacity], [ssd_equipment_code], [remark]) VALUES (16, 16, 16, 0, 'Done', '128 GB', 'ITSW0059', NULL);
INSERT INTO dbo.ssd_upgrade ([upgrade_id], [employee_id], [equipment_id], [charge_cable_needed], [replace_status], [ssd_capacity], [ssd_equipment_code], [remark]) VALUES (17, 17, 17, 0, 'Done', '128 GB', 'ITSW0061', NULL);
INSERT INTO dbo.ssd_upgrade ([upgrade_id], [employee_id], [equipment_id], [charge_cable_needed], [replace_status], [ssd_capacity], [ssd_equipment_code], [remark]) VALUES (18, 18, 18, 0, NULL, '128 GB', 'ITSW0057', NULL);
INSERT INTO dbo.ssd_upgrade ([upgrade_id], [employee_id], [equipment_id], [charge_cable_needed], [replace_status], [ssd_capacity], [ssd_equipment_code], [remark]) VALUES (19, 19, 19, 0, 'Done', '128 GB', 'ITSW0049', NULL);
INSERT INTO dbo.ssd_upgrade ([upgrade_id], [employee_id], [equipment_id], [charge_cable_needed], [replace_status], [ssd_capacity], [ssd_equipment_code], [remark]) VALUES (20, 20, 20, 0, 'Done', '128 GB', NULL, NULL);
INSERT INTO dbo.ssd_upgrade ([upgrade_id], [employee_id], [equipment_id], [charge_cable_needed], [replace_status], [ssd_capacity], [ssd_equipment_code], [remark]) VALUES (21, 21, 21, 1, 'Done', NULL, NULL, NULL);

-- Schema for dbo.ssd_procurement:
--   procurement_id int NOT NULL IDENTITY PRIMARY KEY
--   model_name varchar(60) NOT NULL
--   qty int NOT NULL
--   decision varchar(20) NULL

-- dbo.ssd_procurement: 5 rows
INSERT INTO dbo.ssd_procurement ([procurement_id], [model_name], [qty], [decision]) VALUES (1, '10A6S1BW00', 3, 'Not Buy');
INSERT INTO dbo.ssd_procurement ([procurement_id], [model_name], [qty], [decision]) VALUES (2, 'P2-1171d', 10, 'Not Buy');
INSERT INTO dbo.ssd_procurement ([procurement_id], [model_name], [qty], [decision]) VALUES (3, 'HP 650 G1', 3, 'Buy');
INSERT INTO dbo.ssd_procurement ([procurement_id], [model_name], [qty], [decision]) VALUES (4, 'HP 650 G2', 3, 'Buy');
INSERT INTO dbo.ssd_procurement ([procurement_id], [model_name], [qty], [decision]) VALUES (5, '20207', 1, 'Buy');

