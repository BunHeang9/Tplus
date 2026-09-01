const bcrypt = require('bcryptjs');
const userModel = require('../models/userModel');
const { notifyPasswordChanged } = require('../utils/mailer');

const SALT_ROUNDS = 10;

// Admin-only user management. Password hashes are never returned by any of
// these - the model queries omit the column entirely rather than relying on
// the controller to strip it.

async function getAll(req, res, next) {
  try {
    const users = await userModel.findAll(req.query.active_only !== 'true');
    res.json({
      count: users.length,
      pending_approval: users.filter(u => !u.is_active).length,
      users,
    });
  } catch (err) { next(err); }
}

async function getById(req, res, next) {
  try {
    const user = await userModel.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) { next(err); }
}

// Change name, role, or activate/deactivate. Also how a pending signup gets
// approved: { "is_active": true }
async function update(req, res, next) {
  const { role, is_active } = req.body;

  if (role && !['admin', 'viewer'].includes(role)) {
    return res.status(400).json({ error: "role must be either 'admin' or 'viewer'" });
  }

  try {
    const target = await userModel.findById(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });

    // Guard against locking everyone out: don't let the last active admin
    // demote themselves or be switched off.
    const losingAdmin =
      (target.role === 'admin' && role === 'viewer') ||
      (target.role === 'admin' && is_active === false);

    if (losingAdmin) {
      const othersLeft = await userModel.countAdmins(target.user_id);
      if (othersLeft === 0) {
        return res.status(409).json({
          error: 'This is the only active admin account',
          hint: 'Promote another user to admin first, otherwise nobody could manage the system.',
        });
      }
    }

    const updated = await userModel.update(req.params.id, req.body);
    res.json({ message: 'User updated', user: updated });
  } catch (err) { next(err); }
}

// Admin resets a forgotten password. Deliberately does not require the old one.
async function resetPassword(req, res, next) {
  const { new_password } = req.body;

  if (!new_password || new_password.length < 8) {
    return res.status(400).json({ error: 'new_password is required, minimum 8 characters' });
  }

  try {
    const target = await userModel.findById(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });

    const hash = await bcrypt.hash(new_password, SALT_ROUNDS);
    const result = await userModel.setPassword(req.params.id, hash);
    // Best-effort, doesn't block the response - see
    // utils/mailer.js's notifyPasswordChanged() for why every
    // password-change path does this. req.user is the admin doing the
    // resetting (from authenticate()), not the account being reset.
    await notifyPasswordChanged(target.email, `by an administrator (${req.user.username})`);
    res.json({ message: `Password reset for ${result.username}` });
  } catch (err) { next(err); }
}

// Permanent - no recycle bin for accounts (see userModel.remove()'s own
// comment for why). Guarded the same way update()'s role-change/deactivate
// path already is for the last-admin case, plus two more that don't apply
// there: never your own account (this app re-validates credentials on every
// request, so deleting yourself would lock you out immediately, not just on
// next login), and never an account still referenced by part-loan history.
async function remove(req, res, next) {
  try {
    const target = await userModel.findById(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });

    if (Number(req.params.id) === req.user.user_id) {
      return res.status(409).json({
        error: 'You cannot delete your own account',
        hint: 'Have another admin do it, or deactivate your account instead.',
      });
    }

    if (target.role === 'admin') {
      const othersLeft = await userModel.countAdmins(target.user_id);
      if (othersLeft === 0) {
        return res.status(409).json({
          error: 'This is the only active admin account',
          hint: 'Promote another user to admin first, otherwise nobody could manage the system.',
        });
      }
    }

    const refs = await userModel.countReferences(target.user_id);
    const total = refs.issued_part_loans + refs.received_part_loans;
    if (total > 0) {
      return res.status(409).json({
        error: `Cannot delete ${target.username}: they still have records attached`,
        references: refs,
        hint: 'Part-loan history records this account as who issued or received a loan, and cannot be reassigned - deactivate the account instead.',
      });
    }

    await userModel.remove(target.user_id);
    res.json({ message: `User "${target.username}" deleted` });
  } catch (err) { next(err); }
}

module.exports = { getAll, getById, update, resetPassword, remove };
