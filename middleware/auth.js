const bcrypt = require('bcryptjs');
const { sql, poolPromise } = require('../config/db');

// Checks username + password on EVERY request.
//
// Credentials can be sent either as:
//   1. HTTP Basic Auth header:  Authorization: Basic base64(username:password)
//   2. Query parameters:        ?username=X&password=Y
//
// NOTE ON SECURITY: this transmits the password on every single request, rather
// than once at login. Passwords sent this way commonly end up recorded in server
// logs, browser history, and proxy caches, and they never expire. A token-based
// approach (which this replaced) avoids those issues. Documented here so whoever
// maintains this later understands the tradeoff that was chosen.
async function authenticate(req, res, next) {
  let username;
  let password;

  const authHeader = req.headers.authorization;

  if (authHeader && authHeader.startsWith('Basic ')) {
    const base64 = authHeader.split(' ')[1];
    const decoded = Buffer.from(base64, 'base64').toString('utf8');
    const separatorIndex = decoded.indexOf(':');
    username = decoded.slice(0, separatorIndex);
    password = decoded.slice(separatorIndex + 1);
  } else if (req.query.username && req.query.password) {
    username = req.query.username;
    password = req.query.password;
  } else if (req.body && req.body.username && req.body.password) {
    username = req.body.username;
    password = req.body.password;
  }

  if (!username || !password) {
    return res.status(401).json({
      error: 'Username and password required. Send as ?username=X&password=Y or via Basic auth header.',
    });
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

    req.user = {
      user_id: user.user_id,
      username: user.username,
      full_name: user.full_name,
      role: user.role,
    };

    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required for this action' });
  }
  next();
}

module.exports = { authenticate, requireAdmin };
