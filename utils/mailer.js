const nodemailer = require('nodemailer');

// SMTP_HOST is the one required setting - if it's not in .env, the app
// isn't configured to send real email yet. Rather than fail every
// forgot-password request until someone sets this up, sendMail() falls
// back to logging the message to the console instead - so the whole
// forgot/reset-password flow is fully testable today, and becomes real
// mail the moment real SMTP_* values are added to .env, with no code
// change needed on either side of that switch.
const configured = !!process.env.SMTP_HOST;

let transporter = null;
function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_PORT === '465',
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
        : undefined,
    });
  }
  return transporter;
}

// Never throws - a failed send (or no SMTP configured at all) should not
// turn into a 500 for the caller, particularly forgot-password, which
// always has to return the same success response regardless of what
// actually happened, so as not to reveal whether an account exists.
async function sendMail({ to, subject, text }) {
  if (!configured) {
    console.log(`[mailer] SMTP not configured - would have sent to ${to}:\n  Subject: ${subject}\n  ${text}`);
    return { sent: false, reason: 'not_configured' };
  }

  try {
    await getTransporter().sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject,
      text,
    });
    return { sent: true };
  } catch (err) {
    console.error('[mailer] send failed:', err.message);
    return { sent: false, reason: 'send_failed' };
  }
}

// Fired after every successful password change, from all three places one
// can happen (forgot/reset-code, self-service change-password, and an
// admin's forced reset) - so the account owner finds out immediately if a
// change wasn't actually them, the same "did you do this?" pattern most
// real account systems use. Best-effort and silent when there's no email
// on file - never blocks or fails the password change itself, matching
// sendMail()'s own never-throws contract.
async function notifyPasswordChanged(to, howChanged) {
  if (!to) return { sent: false, reason: 'no_email' };
  return sendMail({
    to,
    subject: 'Your Tplus password was changed',
    text: `Your Tplus account password was just changed (${howChanged}). If this was you, no action is needed.\n\nIf it wasn't you, contact an administrator immediately - someone else may have access to your account.`,
  });
}

module.exports = { sendMail, notifyPasswordChanged };
