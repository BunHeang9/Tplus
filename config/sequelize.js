const { Sequelize } = require('sequelize');
require('dotenv').config();

// The single connection every model in the app goes through - same
// database, same credentials, same env vars the old raw mssql pool
// (config/db.js, now unused) connected with.
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

// Sequelize connects lazily on first query by default, so a bad connection
// would otherwise stay silent until the first request touches the database
// instead of failing loudly at startup - .authenticate() forces an eager
// check, same as the old raw pool's own .connect() did.
sequelize.authenticate()
  .then(() => console.log('Connected to Tplus SQL Server database'))
  .catch((err) => console.error('Database connection failed:', err.message));

module.exports = sequelize;
