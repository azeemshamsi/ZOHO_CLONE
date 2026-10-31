const nodemailer = require("nodemailer");
const env = require("../config/env");

let transporter;

module.exports = async function sendEmail(to, subject, text) {
  if (!env.emailEnabled) {
    console.log(`[email disabled] Would send "${subject}" to ${to}: ${text}`);
    return false;
  }
  transporter =
    transporter ||
    nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    });
  await transporter.sendMail({ from: env.MAIL_FROM, to, subject, text });
  return true;
};
