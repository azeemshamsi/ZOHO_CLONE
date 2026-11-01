/**
 * Send email for an organization: its own SMTP settings (Settings → Email) if filled in,
 * otherwise the server's SMTP_* environment variables.
 */
const nodemailer = require("nodemailer");
const env = require("../config/env");

function transportFor(org) {
  const s = org.smtp || {};
  if (s.host && s.user && s.pass)
    return { t: nodemailer.createTransport({ host: s.host, port: s.port || 587, secure: !!s.secure, auth: { user: s.user, pass: s.pass } }), from: `"${s.fromName || org.name}" <${s.user}>` };
  if (env.emailEnabled)
    return { t: nodemailer.createTransport({ host: env.SMTP_HOST, port: env.SMTP_PORT, secure: env.SMTP_SECURE, auth: { user: env.SMTP_USER, pass: env.SMTP_PASS } }), from: `"${org.name}" <${env.MAIL_FROM || env.SMTP_USER}>` };
  return null;
}

const canEmail = (org) => Boolean(transportFor(org));

async function sendOrgMail(org, { to, cc, subject, text, attachments, replyTo }) {
  const tr = transportFor(org);
  if (!tr) {
    const { HttpError } = require("./http");
    throw new HttpError(400, "Email isn't set up yet. Add your email account in Settings → Email.");
  }
  try {
    await tr.t.sendMail({ from: tr.from, to, cc: cc && cc.length ? cc : undefined, replyTo: replyTo || org.email || undefined, subject, text, attachments });
  } catch (e) {
    const { HttpError } = require("./http");
    throw new HttpError(502, `The email server refused the message: ${e.message}`);
  }
}

module.exports = { sendOrgMail, canEmail };
