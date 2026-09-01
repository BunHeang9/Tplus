// DB-backed - see tests/README.md. Scratch server equipment only.
//
// Covers server_usage's core design decision from this migration: every
// save is a new history row (never overwrites), a field left out of a call
// carries forward from the most recent prior entry, and percent values get
// a "%" auto-appended.
const sequelize = require('../../config/sequelize');
const { QueryTypes } = require('sequelize');
const serverUsageModel = require('../../models/serverUsageModel');
const equipmentModel = require('../../models/equipmentModel');

let serverCategory;
let equip;

beforeAll(async () => {
  [serverCategory] = await sequelize.query("SELECT category_id FROM dbo.category WHERE category_name = 'Server'", { type: QueryTypes.SELECT });
  equip = await equipmentModel.createStock({
    category_id: serverCategory.category_id, device_type: 'Test',
    asset_code: 'TSTSU-JEST-' + Date.now().toString().slice(-6),
    cpu: '8', ram: '16', hd: '500',
  });
});

afterAll(async () => {
  await sequelize.query('DELETE FROM dbo.server_usage WHERE equipment_id = :id', { replacements: { id: equip.equipment_id } });
  await sequelize.query('DELETE FROM dbo.equipment WHERE equipment_id = :id', { replacements: { id: equip.equipment_id } });
});

test('first entry: unsupplied fields stay null, percent values get "%" appended', async () => {
  const entry = await serverUsageModel.upsertServerUsage(equip.equipment_id, { cpu_usage_pct: '45', memory_usage_pct: '60' });
  expect(entry.cpu_usage_pct).toBe('45%');
  expect(entry.memory_usage_pct).toBe('60%');
  expect(entry.hdd_usage_gb).toBeNull();
  expect(entry.remark).toBeNull();
});

test('a later entry carries forward whatever the caller did not supply', async () => {
  await new Promise((r) => setTimeout(r, 20));
  const entry = await serverUsageModel.upsertServerUsage(equip.equipment_id, { remark: 'checked today' });
  expect(entry.cpu_usage_pct).toBe('45%'); // carried forward, not blanked
  expect(entry.memory_usage_pct).toBe('60%');
  expect(entry.remark).toBe('checked today');
});

test('an already-suffixed percent value passes through unchanged', async () => {
  const entry = await serverUsageModel.upsertServerUsage(equip.equipment_id, { cpu_usage_pct: '70%' });
  expect(entry.cpu_usage_pct).toBe('70%'); // not '70%%'
});

test('each call inserts a new row rather than overwriting - a real history log', async () => {
  const history = await serverUsageModel.getServerUsageHistory(null, null);
  const forThisEquipment = history.filter((r) => r.equipment_id === equip.equipment_id);
  expect(forThisEquipment.length).toBe(3);
});

test('getServerUsage() shows this server with its latest entry and TRY_CAST-derived totals', async () => {
  const live = await serverUsageModel.getServerUsage();
  const row = live.find((r) => r.equipment_id === equip.equipment_id);
  expect(row).toBeDefined();
  expect(row.cpu_usage_pct).toBe('70%'); // the most recent entry
  expect(row.cpu_core_total).toBe(8);
  expect(row.memory_gb_total).toBe(16);
  expect(row.hdd_gb_total).toBe(500);
});

test('getServerUsageHistory() with a date range excludes entries outside it', async () => {
  const noResults = await serverUsageModel.getServerUsageHistory('2099-01-01', '2099-12-31');
  expect(noResults.find((r) => r.equipment_id === equip.equipment_id)).toBeUndefined();
});
