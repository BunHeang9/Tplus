const CloudRate = require('./sequelize/cloudRateModel');
const CloudUsage = require('./sequelize/cloudUsageModel');

// Cloud infrastructure cost tracking: the committed rate card
// (dbo.cloud_rate) versus actual monthly usage/spend (dbo.cloud_usage).
//
// First model migrated from raw SQL to Sequelize - picked as the simplest
// starting point (two plain reads, no writes, no joins) to establish the
// pattern before touching anything with transactions or MERGE in it.

async function getCloudRates() {
  const rows = await CloudRate.findAll({
    attributes: [
      'rate_id', 'item_name', 'unit', 'capacity', 'price_type',
      'unit_price', 'total_price_month', 'total_price_year', 'year',
    ],
    order: [['year', 'ASC'], ['rate_id', 'ASC']],
    raw: true,
  });
  return rows;
}

async function getCloudUsage() {
  const rows = await CloudUsage.findAll({
    attributes: ['usage_id', 'item_name', 'unit', 'unit_cost', 'usage_month', 'quantity', 'amount'],
    order: [['usage_month', 'ASC'], ['usage_id', 'ASC']],
    raw: true,
  });
  return rows;
}

module.exports = { getCloudRates, getCloudUsage };
