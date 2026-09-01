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

module.exports = { sendMail };
