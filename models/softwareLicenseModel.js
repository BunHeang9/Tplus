const { poolPromise } = require('../config/db');
const sql = require('mssql');

// Get all software licenses for dropdown (used in equipment form)
async function getAllLicenses() {
  try {
    const pool = await poolPromise;
    const result = await pool
      .request()
      .query(`
        SELECT 
          license_id,
          product_name,
          product_type,
          license_type,
          date_start,
          date_expire,
          status,
          remark
        FROM [Tplus].[dbo].[software_license]
        ORDER BY product_name ASC
      `);
    
    return result.recordset.map(license => ({
      ...license,
      calculated_status: calculateLicenseStatus(license)
    }));
  } catch (err) {
    throw err;
  }
}

// Get license for specific equipment
async function getEquipmentLicense(equipment_id) {
  try {
    const pool = await poolPromise;
    const result = await pool
      .request()
      .input('equipment_id', sql.Int, equipment_id)
      .query(`
        SELECT 
          sl.license_id,
          sl.product_name,
          sl.product_type,
          sl.license_type,
          sl.date_start,
          sl.date_expire,
          sl.status,
          sl.remark
        FROM [Tplus].[dbo].[software_license] sl
        INNER JOIN [Tplus].[dbo].[equipment] e ON e.license_id = sl.license_id
        WHERE e.equipment_id = @equipment_id
      `);
    
    if (result.recordset.length === 0) {
      return null;
    }

    const license = result.recordset[0];
    return {
      ...license,
      calculated_status: calculateLicenseStatus(license)
    };
  } catch (err) {
    throw err;
  }
}

// Assign software license to equipment
async function assignLicenseToEquipment(equipment_id, license_id) {
  try {
    const pool = await poolPromise;
    const result = await pool
      .request()
      .input('equipment_id', sql.Int, equipment_id)
      .input('license_id', sql.Int, license_id)
      .query(`
        UPDATE [Tplus].[dbo].[equipment]
        SET license_id = @license_id
        WHERE equipment_id = @equipment_id
        
        SELECT 
          equipment_id,
          license_id,
          device_name,
          device_type,
          status
        FROM [Tplus].[dbo].[equipment]
        WHERE equipment_id = @equipment_id
      `);
    
    return result.recordset[0];
  } catch (err) {
    throw err;
  }
}

// Remove license from equipment
async function removeLicenseFromEquipment(equipment_id) {
  try {
    const pool = await poolPromise;
    const result = await pool
      .request()
      .input('equipment_id', sql.Int, equipment_id)
      .query(`
        UPDATE [Tplus].[dbo].[equipment]
        SET license_id = NULL
        WHERE equipment_id = @equipment_id
        
        SELECT 
          equipment_id,
          license_id,
          device_name,
          device_type
        FROM [Tplus].[dbo].[equipment]
        WHERE equipment_id = @equipment_id
      `);
    
    return result.recordset[0];
  } catch (err) {
    throw err;
  }
}

// Calculate license status based on type and dates
function calculateLicenseStatus(license) {
  if (!license) return 'unknown';
  
  // Free and Perpetual licenses are always active
  if (license.license_type === 'Free' || license.license_type === 'Perpetual') {
    return 'active';
  }
  
  // Annual Subscription - calculate based on dates
  if (license.license_type === 'Annual Subscription') {
    const today = new Date();
    const dateStart = new Date(license.date_start);
    const dateExpire = new Date(license.date_expire);
    
    if (today < dateStart) {
      return 'pending';
    }
    
    if (today > dateExpire) {
      return 'expired';
    }
    
    // Check if expiring within 30 days
    const daysUntilExpire = Math.floor((dateExpire - today) / (1000 * 60 * 60 * 24));
    if (daysUntilExpire > 0 && daysUntilExpire <= 30) {
      return 'near_expire';
    }
    
    if (today >= dateStart && today <= dateExpire) {
      return 'active';
    }
  }
  
  return 'unknown';
}

module.exports = {
  getAllLicenses,
  getEquipmentLicense,
  assignLicenseToEquipment,
  removeLicenseFromEquipment,
  calculateLicenseStatus,
};
