const { Sequelize } = require('sequelize');
require('dotenv').config();

// Sequelize, alongside the existing raw mssql pool in db.js - not a
// replacement for it. Same database, same credentials, same env vars.
// Existing models keep using db.js/poolPromise exactly as they do today;
// this is only for new code that wants an ORM instead of hand-written SQL.
// A lot of what's already in this app (MERGE-based upserts, OUTER APPLY,
// dynamic multi-filter WHERE clauses, multi-table transactions) doesn't map
// cleanly onto Sequelize's query builder, so migrating the existing models
// wasn't in scope here - this is additive, not a rewrite.
const sequelize = new Sequelize(
  process.env.DB_DATABASE,
  process.env.DB_USER,
  process.env.DB_PASSWORD,
  {
    host: process.env.DB_SERVER,
    port: parseInt(process.env.DB_PORT || '1433', 10),
    dialect: 'mssql',
    dialectOptions: {
      options: {
        encrypt: process.env.DB_ENCRYPT === 'true',
        trustServerCertificate: process.env.DB_TRUST_SERVER_CERTIFICATE === 'true',
      },
    },
    pool: {
      max: 10,
      min: 0,
      idle: 30000,
    },
    logging: false,
  },
);

module.exports = sequelize;
