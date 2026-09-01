const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const userModel = require('../models/userModel');
const { sendMail, notifyPasswordChanged } = require('../utils/mailer');

const SALT_ROUNDS = 10;
const RESET_CODE_TTL_MINUTES = 10; // short-lived - a 6-digit code is brute-forceable given enough time

// New signups wait for admin approval by default. The API sits on a public URL,
// so without this anyone who finds it could read the whole inventory.
// Set REQUIRE_ADMIN_APPROVAL=false in .env for open signup.
const REQUIRE_APPROVAL = process.env.REQUIRE_ADMIN_APPROVAL !== 'false';

// Crude in-memory throttle, shared by signup and forgot-password - both are
// public, unauthenticated, and can be hammered by a script (forgot-password
// doubly so once real SMTP is configured, since each hit sends a real
// email). Resets when the server restarts; a real deployment would use a
// shared store.
function makeThrottle(windowMs, max) {
  const hits = new Map();
  return (ip) => {
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    recent.push(now);
    hits.set(ip, recent);
    return recent.length > max;
  };
}
const tooManySignups = makeThrottle(60 * 60 * 1000, 5);
const tooManyForgotPasswords = makeThrottle(60 * 60 * 1000, 5);

// Verifies credentials. Note there's no token issued - the frontend must
// send username/password on every subsequent request (see middleware/auth.js).
// The `username` field accepts either a real username or an email address -
// the frontend's Sign In form now collects an email but still sends it in
// this same field, no request shape change. middleware/auth.js's own
// authenticate() (which re-verifies credentials on every other request, not
// just this one) resolves the identifier the same way, or a login here
// would succeed while every subsequent request failed.
async function login(req, res, next) {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  try {
    const user = await userModel.findByUsernameOrEmail(username);

    // Deliberately vague - don't reveal whether the account exists
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
        email: user.email,
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
    // Best-effort, doesn't block the response - see notifyPasswordChanged()'s
    // own comment for why every password-change path does this.
    await notifyPasswordChanged(user.email, 'by you, from your account');
    res.json({ message: 'Password changed' });
  } catch (err) {
    next(err);
  }
}

// Admin-only: create another login account.
async function register(req, res, next) {
  const { new_username, new_password, full_name, email, role } = req.body;

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
      email,
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
  const { username, password, full_name, email } = req.body;

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
      email,
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

// Public, unauthenticated (the whole point is the caller can't log in).
// Always returns the same generic response regardless of whether the
// username exists, has no email on file, or is inactive - the response
// content must never be how someone finds out whether an account exists.
// The code itself, the account lookup, and the email send all happen (or
// don't) behind that single unchanging response.
async function forgotPassword(req, res, next) {
  const { username } = req.body;
  const GENERIC_RESPONSE = { message: 'If an account exists, a reset code has been sent to its email.' };

  if (tooManyForgotPasswords(req.ip)) {
    // Same generic response even when throttled - a distinct error here
    // would itself leak information about request patterns.
    return res.json(GENERIC_RESPONSE);
  }
  if (!username) {
    return res.status(400).json({ error: 'username is required' });
  }

  try {
    // Same broadened lookup as login()/authenticate() - the frontend's
    // forgot-password form is likely to send whichever identifier its
    // Sign In form now collects (email), and there's no reason for this
    // endpoint to reject that when login itself accepts it.
    const user = await userModel.findByUsernameOrEmail(username);
    if (user && user.is_active && user.email) {
      // A 6-digit code, zero-padded (e.g. "042917") - crypto.randomInt is
      // the same non-predictable source used everywhere else a secret is
      // generated in this app, just over a much smaller range than a link
      // token needs. Only a hash of it ever reaches the database
      // (userModel.setResetToken) - the raw code exists only in memory
      // here and in the email itself, same reasoning as never storing a
      // plaintext password. Its small range is exactly why
      // userModel.redeemResetCode() has to cap wrong guesses - see its
      // own comment.
      const rawCode = crypto.randomInt(0, 1000000).toString().padStart(6, '0');
      const codeHash = crypto.createHash('sha256').update(rawCode).digest('hex');
      await userModel.setResetToken(user.user_id, codeHash, RESET_CODE_TTL_MINUTES);

      await sendMail({
        to: user.email,
        subject: 'Your Tplus password reset code',
        text: `Someone requested a password reset for your Tplus account. If this was you, enter this code where prompted - it expires in ${RESET_CODE_TTL_MINUTES} minutes and can only be used once:\n\n${rawCode}\n\nIf you didn't request this, you can safely ignore this email - your password has not been changed.`,
      });
    }
    res.json(GENERIC_RESPONSE);
  } catch (err) {
    next(err);
  }
}

// Public, unauthenticated - the caller proves who they are with the code
// from the email, not credentials, so this needs the identifier too
// (unlike the link-token version this replaced, a 6-digit code alone
// isn't enough to look the account up unambiguously - see
// userModel.redeemResetCode()'s own comment). Named distinctly from
// userController.resetPassword (the admin-only forced reset) to avoid
// confusion when reading routes/authRoutes.js and routes/userRoutes.js
// side by side; the two are unrelated flows serving different callers.
async function resetPasswordWithCode(req, res, next) {
  const { username, code, new_password } = req.body;

  if (!username || !code || !new_password) {
    return res.status(400).json({ error: 'username, code, and new_password are required' });
  }
  if (new_password.length < 8) {
    return res.status(400).json({ error: 'new_password must be at least 8 characters' });
  }

  try {
    const codeHash = crypto.createHash('sha256').update(code).digest('hex');
    const hash = await bcrypt.hash(new_password, SALT_ROUNDS);
    // See userModel.redeemResetCode()'s own comment for how this verifies
    // the code, enforces the attempt cap, and clears it atomically on
    // success - a wrong guess here still counts toward that account's
    // attempt limit even though this call fails.
    const result = await userModel.redeemResetCode(username, codeHash, hash);

    if (!result) {
      return res.status(400).json({
        error: 'That code is incorrect, expired, or has been guessed wrong too many times',
        hint: 'Request a new password reset code.',
      });
    }

    // Best-effort, doesn't block the response - see notifyPasswordChanged()'s
    // own comment for why every password-change path does this.
    await notifyPasswordChanged(result.email, 'using a password-reset code');
    res.json({ message: 'Password has been reset. You can log in with your new password now.' });
  } catch (err) {
    next(err);
  }
}

module.exports = { login, register, signup, me, changePassword, forgotPassword, resetPasswordWithCode };
