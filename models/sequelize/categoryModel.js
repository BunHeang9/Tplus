const { DataTypes } = require('sequelize');
const sequelize = require('../../config/sequelize');

// Sequelize definition for dbo.category, used by models/categoryModel.js.
const Category = sequelize.define('Category', {
  category_id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  category_name: {
    type: DataTypes.STRING(50),
    allowNull: false,
  },
  description: {
    type: DataTypes.STRING(255),
    allowNull: true,
  },
  is_active: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true,
  },
  // Has its own DB-side default, same as the original raw INSERT relied on
  // (it never set this column either). allowNull: true here is not the
  // real schema - it only stops Sequelize validating a value into
  // existence client-side. With no defaultValue and nothing passed to
  // create(), Sequelize omits this column from the INSERT entirely and
  // the DB default fills it in - the same server clock the raw SQL
  // version used, not Sequelize's own date formatting (which sends a
  // timezone-offset suffix plain DATETIME columns reject; this table's
  // created_at is legacy DATETIME, not DATETIME2).
  created_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  view_key: {
    type: DataTypes.STRING(50),
    allowNull: true,
  },
}, {
  tableName: 'category',
  schema: 'dbo',
  timestamps: false,
});

module.exports = Category;
