const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { sql, poolPromise } = require('../config/db');
const { authenticate, requireAdmin } = require('../middleware/auth');

// This file is use to Create  URLs that client can call
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  try {
    const pool = await poolPromise;
    const result = await pool
      .request()
      .input('username', sql.VarChar, username)
      .query('SELECT user_id, username, password_hash, full_name, role, is_active FROM dbo.api_user WHERE username = @username');

    const user = result.recordset[0];

    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    if (!user.is_active) {
      return res.status(403).json({ error: 'This account has been deactivated' });
    }

    const matches = await bcrypt.compare(password, user.password_hash);
    if (!matches) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    res.json({
      success: true,
      user: {
        user_id: user.user_id,
        username: user.username,
        full_name: user.full_name,
        role: user.role,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/register  (admin only)
router.post('/register', authenticate, requireAdmin, async (req, res) => {
  const { new_username, new_password, full_name, role } = req.body;

  if (!new_username || !new_password) {
    return res.status(400).json({ error: 'new_username and new_password are required' });
  }
  if (new_password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (role && !['admin', 'viewer'].includes(role)) {
    return res.status(400).json({ error: "role must be either 'admin' or 'viewer'" });
  }

  try {
    const pool = await poolPromise;
    const passwordHash = await bcrypt.hash(new_password, 10);

    const result = await pool
      .request()
      .input('username', sql.VarChar, new_username)
      .input('password_hash', sql.VarChar, passwordHash)
      .input('full_name', sql.NVarChar, full_name || null)
      .input('role', sql.VarChar, role || 'viewer')
      .query(`
        INSERT INTO dbo.api_user (username, password_hash, full_name, role)
        OUTPUT INSERTED.user_id, INSERTED.username, INSERTED.full_name, INSERTED.role, INSERTED.created_at
        VALUES (@username, @password_hash, @full_name, @role)
      `);

    res.status(201).json(result.recordset[0]);
  } catch (err) {
    if (err.number === 2627 || err.number === 2601) {
      return res.status(409).json({ error: 'That username is already taken' });
    }
    res.status(500).json({ error: err.message });
  }
});

router.get('/me', authenticate, (req, res) => {
  res.json(req.user);
});

module.exports = router;
