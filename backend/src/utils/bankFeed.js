/**
 * Bank statement auto-import from email. Every 15 minutes (and on "Check mail now") OrdexaGo opens each company's
 * statement mailbox over IMAP, looks at new mail (from the bank senders, if set) with attachments, reads the
 * statement files and imports them into the bank account whose number is in the file. The usual duplicate check
 * and transaction rules apply, so a daily statement that repeats yesterday's lines adds only the new ones.
 * Mail is only read: nothing is deleted, moved or marked as read.
 */
const BankFeed = require("../models/BankFeed");
const Account = require("../models/Account");
const { parseStatement } = require("./statementParse");
const { importRows } = require("./bankImport");

const digits = (s) => String(s || "").replace(/[^0-9]/g, "");
const running = new Set();

// The fed account whose number matches the statement's (full match, or the last 4+ digits of a masked number).
function accountFor(feed, number) {
  const on = (feed.accounts || []).filter((a) => a.enabled !== false && digits(a.accountNumber));
  const n = digits(number);
  if (n) {
    const hit = on.find((a) => digits(a.accountNumber) === n) || on.find((a) => digits(a.accountNumber).replace(/^0+/, "") === n.replace(/^0+/, ""));
    if (hit) return hit;
    if (/[x*]/i.test(number) && n.length >= 4) return on.find((a) => digits(a.accountNumber).endsWith(n.slice(-4)));
    return null;
  }
  return on.length === 1 ? on[0] : null;
}

function senderOk(feed, from) {
  const list = String(feed.senders || "")
    .split(/[,\s;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!list.length) return true;
  const f = String(from || "").toLowerCase();
  return list.some((s) => f === s || f.endsWith(s.startsWith("@") ? s : `@${s}`) || f.endsWith(`.${s.replace(/^@/, "")}`));
}

async function runFeed(feedOrId, { days } = {}) {
  const feed = feedOrId._id ? feedOrId : await BankFeed.findById(feedOrId);
  const key = String(feed.organization);
  if (running.has(key)) return { busy: true, results: [] };
  running.add(key);
  const results = [];
  const { ImapFlow } = require("imapflow");
  const { simpleParser } = require("mailparser");
  const client = new ImapFlow({
    host: feed.host || "imap.gmail.com",
    port: feed.port || 993,
    secure: (feed.port || 993) === 993,
    auth: { user: feed.user, pass: feed.imapPass },
    logger: false,
    socketTimeout: 120000,
  });
  feed.lastRunAt = new Date();
  try {
    if (!feed.user || !feed.imapPass) throw new Error("Mailbox address and app password aren't set");
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const back = days ? Number(days) : feed.lastOkAt ? Math.min(7, Math.ceil((Date.now() - feed.lastOkAt) / 86400000) + 2) : 7;
      const since = new Date(Date.now() - Math.min(Math.max(back, 1), 60) * 86400000);
      const uids = (await client.search({ since }, { uid: true })) || [];
      const done = new Set(feed.processed || []);
      const codes = new Set((await Account.find({ organization: feed.organization }, { code: 1 }).lean()).map((a) => a.code));
      for (const uid of uids.slice(-300)) {
        const head = await client.fetchOne(String(uid), { envelope: true, bodyStructure: true }, { uid: true });
        if (!head) continue;
        const env = head.envelope || {};
        const id = env.messageId || `uid:${uid}:${env.date}`;
        if (done.has(id)) continue;
        const from = env.from?.[0]?.address || "";
        if (!senderOk(feed, from)) continue;
        const hasFile = JSON.stringify(head.bodyStructure || {}).match(/"disposition":"attachment"|\.(csv|xlsx?|pdf)"/i);
        if (!hasFile) {
          done.add(id);
          continue;
        }
        const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
        const mail = await simpleParser(msg.source);
        const files = (mail.attachments || []).filter((a) => /\.(csv|txt|xls|xlsx|xlsm|pdf)$/i.test(a.filename || "") || /csv|excel|spreadsheet|pdf/i.test(a.contentType || ""));
        let retry = false; // not set up yet / wrong password: try this email again on the next check
        for (const f of files) {
          const base = { at: new Date(), mailAt: env.date, from, subject: String(env.subject || "").slice(0, 150), file: f.filename || "" };
          try {
            const pw = Object.values(feed.filePasswords || {}).filter(Boolean);
            const st = await parseStatement(f.content, f.filename, pw);
            const acc = accountFor(feed, st.accountNumber);
            if (!acc) throw new Error(`Account ${st.accountNumber || "(no number in the file)"} isn't set up for auto-import`);
            if (!codes.has(acc.code)) throw new Error(`Bank account ${acc.code} no longer exists`);
            const r = st.rows.length ? await importRows(feed.organization, acc.code, st.rows) : { imported: 0, skipped: 0, ignored: 0, rules: 0 };
            results.push({ ...base, account: acc.code, accountNumber: st.accountNumber, lines: st.rows.length, imported: r.imported, skipped: r.skipped, rules: r.rules?.categorized || 0 });
          } catch (e) {
            if (/isn't set up|password/i.test(e.message)) retry = true;
            if (!(feed.log || []).some((l) => l.error === e.message && l.file === base.file && String(l.subject) === base.subject)) results.push({ ...base, error: e.message });
          }
        }
        if (!files.length) results.push({ at: new Date(), mailAt: env.date, from, subject: String(env.subject || "").slice(0, 150), error: "No CSV / Excel statement attached" });
        if (!retry) done.add(id);
      }
      feed.processed = [...done].slice(-2000);
    } finally {
      lock.release();
    }
    await client.logout().catch(() => {});
    feed.lastOkAt = feed.lastRunAt;
    feed.lastError = "";
  } catch (e) {
    const m = e.authenticationFailed || /AUTHENTICATIONFAILED|Invalid credentials/i.test(e.responseText || e.message || "")
      ? "The mailbox refused the login — check the email address and the app password (Gmail needs an app password, not your normal password)"
      : e.responseText || e.message;
    feed.lastError = String(m).slice(0, 300);
    try {
      client.close();
    } catch {}
  } finally {
    running.delete(key);
  }
  feed.log = [...results.reverse(), ...(feed.log || [])].slice(0, 100);
  feed.markModified("log");
  await feed.save();
  if (results.length) console.log(`[bankfeed] ${key}: ${results.map((r) => (r.error ? `${r.file || r.subject}: ${r.error}` : `${r.account} +${r.imported} (${r.skipped} already in)`)).join("; ")}`);
  return { results, error: feed.lastError };
}

async function runAll() {
  const feeds = await BankFeed.find({ enabled: true });
  for (const f of feeds) await runFeed(f).catch((e) => console.error("[bankfeed] failed:", e.message));
}

module.exports = { runFeed, runAll, accountFor };
