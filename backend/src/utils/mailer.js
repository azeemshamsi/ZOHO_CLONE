/**
 * Send email for an organization: its own settings (Settings → Email) if filled in,
 * otherwise the server's environment variables.
 *
 * Providers:
 *   smtp   – any mailbox (Gmail, Zoho Mail, Outlook…). Needs outbound ports 465/587, which
 *            Render's FREE plan blocks.
 *   brevo  – Brevo's HTTPS API (free 300 emails/day). Works on Render's free plan.
 *   resend – Resend's HTTPS API (free 3,000 emails/month, needs your domain verified). Works on Render's free plan.
 */
const nodemailer = require("nodemailer");
const env = require("../config/env");

const API = ["brevo", "resend"];

// The account to send from: { provider, host, port, secure, user, pass, apiKey, email, name }
function accountFor(org) {
  const s = (org && org.smtp) || {};
  const provider = s.provider || "smtp";
  if (API.includes(provider) && s.apiKey && s.user) return { provider, apiKey: s.apiKey, email: s.user, name: s.fromName || org.name };
  if (provider === "smtp" && s.host && s.user && s.pass) return { provider, host: s.host, port: s.port || 587, secure: !!s.secure, user: s.user, pass: s.pass, email: s.user, name: s.fromName || org.name };
  return serverAccount(org?.name);
}

function serverAccount(name = "MGI") {
  const fromEmail = (env.MAIL_FROM || env.SMTP_USER || "").replace(/^.*<(.+)>.*$/, "$1").trim();
  if (env.BREVO_API_KEY && fromEmail) return { provider: "brevo", apiKey: env.BREVO_API_KEY, email: fromEmail, name };
  if (env.RESEND_API_KEY && fromEmail) return { provider: "resend", apiKey: env.RESEND_API_KEY, email: fromEmail, name };
  if (env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS) return { provider: "smtp", host: env.SMTP_HOST, port: env.SMTP_PORT, secure: env.SMTP_SECURE, user: env.SMTP_USER, pass: env.SMTP_PASS, email: fromEmail || env.SMTP_USER, name };
  return null;
}

const list = (v) => (Array.isArray(v) ? v : v ? [v] : []).filter(Boolean);
const b64 = (c) => (Buffer.isBuffer(c) ? c : Buffer.from(String(c))).toString("base64");

async function postJson(url, headers, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", ...headers }, body: JSON.stringify(body), signal: ctrl.signal });
    const text = await r.text();
    if (!r.ok) {
      let msg = text;
      try {
        const j = JSON.parse(text);
        msg = j.message || j.error?.message || j.error || text;
      } catch {}
      throw new Error(`${r.status} ${String(msg).slice(0, 300)}`);
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// Send one message with an account. msg: { to, cc, replyTo, subject, text, attachments:[{filename, content}] }
async function deliver(acc, msg) {
  const to = list(msg.to);
  const cc = list(msg.cc);
  const attachments = msg.attachments || [];
  if (acc.provider === "brevo") {
    return postJson(process.env.BREVO_API_URL || "https://api.brevo.com/v3/smtp/email", { "api-key": acc.apiKey }, {
      sender: { name: acc.name, email: acc.email },
      to: to.map((email) => ({ email })),
      ...(cc.length ? { cc: cc.map((email) => ({ email })) } : {}),
      ...(msg.replyTo ? { replyTo: { email: msg.replyTo } } : {}),
      subject: msg.subject,
      textContent: msg.text,
      ...(attachments.length ? { attachment: attachments.map((a) => ({ name: a.filename, content: b64(a.content) })) } : {}),
    });
  }
  if (acc.provider === "resend") {
    return postJson(process.env.RESEND_API_URL || "https://api.resend.com/emails", { authorization: `Bearer ${acc.apiKey}` }, {
      from: `${acc.name} <${acc.email}>`,
      to,
      ...(cc.length ? { cc } : {}),
      ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
      subject: msg.subject,
      text: msg.text,
      ...(attachments.length ? { attachments: attachments.map((a) => ({ filename: a.filename, content: b64(a.content) })) } : {}),
    });
  }
  const t = nodemailer.createTransport({ host: acc.host, port: acc.port, secure: acc.secure, auth: { user: acc.user, pass: acc.pass }, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000 });
  return t.sendMail({ from: `"${acc.name}" <${acc.email}>`, to, cc: cc.length ? cc : undefined, replyTo: msg.replyTo || undefined, subject: msg.subject, text: msg.text, attachments });
}

// Turn provider errors into something a user can act on.
function explain(acc, e) {
  const m = e.message || String(e);
  if (acc.provider === "smtp" && /ETIMEDOUT|ECONNREFUSED|Connection timeout|Greeting never received|ECONNRESET|EHOSTUNREACH/i.test(m))
    return `Couldn't connect to ${acc.host}:${acc.port}. If MGI runs on Render's free plan, Render blocks email (SMTP) ports — switch the provider to Brevo or Resend in Settings → Email, which send over HTTPS. (${m})`;
  if (acc.provider === "smtp" && /Invalid login|535|534|Username and Password not accepted|authentication/i.test(m))
    return `The mailbox rejected the login for ${acc.user}. For Gmail use an App Password, not your normal password. (${m})`;
  if (/^401\b/.test(m)) return `${acc.provider === "brevo" ? "Brevo" : "Resend"} didn't accept the API key (${m}). Copy the key again — it's shown only once when created — paste it into Settings → Email and save.`;
  if (acc.provider === "brevo" && /sender|not valid|unauthori[sz]ed|403/i.test(m)) return `Brevo refused the message: ${m}. Check that ${acc.email} is a verified sender in Brevo (Senders, Domains & Dedicated IPs → Senders).`;
  if (acc.provider === "resend" && /domain|verify|403|422/i.test(m)) return `Resend refused the message: ${m}. Check that the domain of ${acc.email} is verified in Resend (Domains).`;
  if (/aborted|AbortError/i.test(m)) return `The email service didn't answer in time. Try again.`;
  return `The email service refused the message: ${m}`;
}

const canEmail = (org) => Boolean(accountFor(org));

async function sendOrgMail(org, msg) {
  const { HttpError } = require("./http");
  const acc = accountFor(org);
  if (!acc) throw new HttpError(400, "Email isn't set up yet. Add your email account in Settings → Email.");
  try {
    await deliver(acc, { ...msg, replyTo: msg.replyTo || org.email || undefined });
  } catch (e) {
    console.error(`[email] ${acc.provider} send failed: ${e.message}`);
    throw new HttpError(502, explain(acc, e));
  }
}

// System emails (sign-up verification, password reset, invites): server settings.
async function sendSystemMail(to, subject, text) {
  const acc = serverAccount("MGI");
  if (!acc) {
    console.log(`[email disabled] Would send "${subject}" to ${to}: ${text}`);
    return false;
  }
  try {
    await deliver(acc, { to, subject, text });
    return true;
  } catch (e) {
    console.error(`[email] system mail failed: ${explain(acc, e)}`);
    throw e;
  }
}

module.exports = { sendOrgMail, sendSystemMail, canEmail, serverAccount, explain };
