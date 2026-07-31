// One-time setup script to create your first admin account.
// Usage:  node create-admin.js <username> <password> "<full name>"
// Example: node create-admin.js Tplus Tplus123@99 "Tplus Admin"
//
// After the first admin exists, create further accounts through
// POST /api/auth/register instead of running this again.

const bcrypt = require('bcryptjs');
const userModel = require('./models/userModel');

async function createAdmin() {
  const [, , username, password, fullName] = process.argv;

  if (!username || !password) {
    console.error('Usage: node create-admin.js <username> <password> "<full name>"');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }

  try {
    const existing = await userModel.findByUsername(username);
    if (existing) {
      console.error(`A user named "${username}" already exists.`);
      process.exit(1);
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const created = await userModel.create({
      username,
      passwordHash,
      fullName: fullName || username,
      role: 'admin',
    });

    console.log('Admin account created:');
    console.log(created);
    process.exit(0);
  } catch (err) {
    console.error('Failed to create admin:', err.message);
    process.exit(1);
  }
}

createAdmin();
