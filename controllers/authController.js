const bcrypt = require('bcryptjs');
const userModel = require('../models/userModel');

const SALT_ROUNDS = 10;

// New signups wait for admin approval by default. The API sits on a public URL,
// so without this anyone who finds it could read the whole inventory.
// Set REQUIRE_ADMIN_APPROVAL=false in .env for open signup.
const REQUIRE_APPROVAL = process.env.REQUIRE_ADMIN_APPROVAL !== 'false';

// Crude in-memory throttle on signup - enough to stop a script hammering it.
// Resets when the server restarts; a real deployment would use a shared store.
const signupAttempts = new Map();
const SIGNUP_WINDOW_MS = 60 * 60 * 1000;
const SIGNUP_MAX = 5;

function tooManySignups(ip) {
  const now = Date.now();
  const hits = (signupAttempts.get(ip) || []).filter(t => now - t < SIGNUP_WINDOW_MS);
  hits.push(now);
  signupAttempts.set(ip, hits);
  return hits.length > SIGNUP_MAX;
}

// Verifies credentials. Note there's no token issued - the frontend must
// send username/password on every subsequent request (see middleware/auth.js).
async function login(req, res, next) {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  try {
    const user = await userModel.findByUsername(username);

    // Deliberately vague - don't reveal whether the username exists
    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    if (!user.is_active) {
      return res.status(403).json({
        error: 'This account is not active yet',
        hint: 'New accounts need an administrator to approve them before first use.',
      });
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
    next(err);
  }
}

// Self-service - any logged-in user changes their own password. Deliberately
// never takes a user_id from the body or URL: it only ever acts on
// req.user (set by the authenticate middleware from the credentials the
// caller just proved they know), so there is no way to reach another
// account's password through this endpoint no matter what the request
// body says. Unlike userController.resetPassword (admin-only, for a
// forgotten password), this requires current_password precisely because
// the caller isn't an admin acting on someone else's behalf.
async function changePassword(req, res, next) {
  const { current_password, new_password } = req.body;

  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'current_password and new_password are required' });
  }
  if (new_password.length < 8) {
    return res.status(400).json({ error: 'new_password must be at least 8 characters' });
  }

  try {
    // Re-fetched rather than trusting req.user - authenticate() strips
    // password_hash off before attaching req.user, and this is the one
    // place in the app that needs it again.
    const user = await userModel.findByUsername(req.user.username);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const matches = await bcrypt.compare(current_password, user.password_hash);
    if (!matches) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const hash = await bcrypt.hash(new_password, SALT_ROUNDS);
    await userModel.setPassword(user.user_id, hash);
    res.json({ message: 'Password changed' });
  } catch (err) {
    next(err);
  }
}

// Admin-only: create another login account.
async function register(req, res, next) {
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
    const passwordHash = await bcrypt.hash(new_password, SALT_ROUNDS);
    const created = await userModel.create({
      username: new_username,
      passwordHash,
      fullName: full_name,
      role,
    });
    res.status(201).json(created);
  } catch (err) {
    // 2627 / 2601 are SQL Server's unique-constraint violations
    if (err.number === 2627 || err.number === 2601) {
      return res.status(409).json({ error: 'That username is already taken' });
    }
    next(err);
  }
}

// Public self-service signup. Always creates a viewer - the role cannot be
// chosen by the person signing up, or anyone could make themselves an admin.
async function signup(req, res, next) {
  const { username, password, full_name } = req.body;

  if (tooManySignups(req.ip)) {
    return res.status(429).json({ error: 'Too many signup attempts. Try again later.' });
  }
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }
  if (username.length < 3) {
    return res.status(400).json({ error: 'Username must be at least 3 characters' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  try {
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const created = await userModel.create({
      username,
      passwordHash,
      fullName: full_name,
      role: 'viewer',
      isActive: !REQUIRE_APPROVAL,
    });

    res.status(201).json({
      message: REQUIRE_APPROVAL
        ? 'Account created. An administrator needs to approve it before you can log in.'
        : 'Account created. You can log in now.',
      pending_approval: REQUIRE_APPROVAL,
      user: created,
    });
  } catch (err) {
    if (err.number === 2627 || err.number === 2601) {
      return res.status(409).json({ error: 'That username is already taken' });
    }
    next(err);
  }
}

// Confirms the supplied credentials are valid and echoes the account back.
function me(req, res) {
  res.json(req.user);
}

module.exports = { login, register, signup, me, changePassword };
