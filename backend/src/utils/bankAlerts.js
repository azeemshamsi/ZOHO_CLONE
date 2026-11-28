/**
 * Bank transaction alert emails → one statement line each. Written from HDFC Bank InstaAlerts
 * (alerts@hdfcbank.bank.in / hdfcbank.net) but kept general (amount, debit/credit, account or card digits, date,
 * reference, balance), so similar alerts from other banks read too.
 *
 * Handles, e.g.:
 *  "Rs.4000.00 is debited from your account ending 9181 towards VPA …@ybl (SABA NAAZ) on 18-11-26. UPI transaction reference no.: 668824289945"
 *  "Rs.7000.00 has been successfully credited to your HDFC Bank account ending in 9181 … Date: 16-11-26 … UPI Reference No.: 668600324046"
 *  "Rs. 10000 has been deducted from your Account No. ending in XX9181 for a Transfer to payee …"
 *  "Your account XX9181 is credited with INR 2,500.00 on 27/06/26 at 16:48:02 … via Cash Deposit Machine. Your available balance is INR 1,21,715.23"
 *  "… HDFC Bank Debit Card ending 4479 for ATM withdrawal for Rs 20000.00 … on 18-11-2026 16:06:39 … available balance on your card is Rs 39747.12"
 *  "… NetBanking for payment of Rs. 253577.24 from A/c **********9181 to RAZPCREDCLUB …"
 */
const { parseBankDate } = require("./statementParse");

const AMT = /(?:Rs\.?|INR|₹)\s*([0-9][0-9,]*(?:\.\d{1,2})?)/i;
const num = (s) => Number(String(s).replace(/,/g, ""));

function clean(text) {
  return String(text || "")
    .replace(/ /g, " ")
    .replace(/\[[^\]]*\]/g, " ") // [image: …] / [link] left by html-to-text
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

// IST calendar date of the email, "YYYY-MM-DD".
const istDay = (d) => new Date(new Date(d || Date.now()).getTime() + 5.5 * 3600000).toISOString().slice(0, 10);

/** Returns { deposit, withdrawal, last4, card, date, reference, description, balance } or null (not a transaction alert). */
function parseAlert(text, { subject = "", date } = {}) {
  const t = clean(text);
  if (!t) return null;
  if (/\bOTP\b|one[- ]time password|will be debited|is due|due date|minimum amount due|mandate.*(created|registered)|request(ed)? (money|for)|declined|failed|unsuccessful|could not be/i.test(t.slice(0, 1500))) return null;

  // The transaction sentence: from the first amount that sits near a debit/credit word.
  const DEBIT = /\b(debited|deducted|withdrawn|withdrawal|payment of|paid|spent|sent|transferred|purchase|used)\b/i;
  const CREDIT = /\b(credited|deposited|received|refunded|reversed to)\b/i;
  const m = t.match(AMT);
  if (!m) return null;
  const start = Math.max(0, t.lastIndexOf("\n", m.index) + 1);
  const para = t.slice(start, start + 700);
  const block = t.slice(start, start + 1400);
  const d = para.search(DEBIT);
  const c = para.search(CREDIT);
  if (d === -1 && c === -1) return null;
  const isDebit = d !== -1 && (c === -1 || d < c);
  const amount = num(m[1]);
  if (!(amount > 0)) return null;

  const acct =
    block.match(/(?:a\/c|account)(?:\s*(?:no\.?|number))?\s*(?:ending(?:\s*(?:in|with))?)?\s*[:\-]?\s*(?:xx|x+|\*+)?\s*(\d{4,})\b/i) ||
    block.match(/(?:a\/c|account)[^.\n]{0,40}?(?:xx|x{2,}|\*{2,})(\d{4})\b/i) ||
    block.match(/(?:xx|\*{2,})(\d{4})\b/i);
  const card = block.match(/card(?:\s*no\.?)?\s*(?:ending(?:\s*(?:in|with))?)?\s*[:\-]?\s*(?:xx|x+|\*+)?\s*(\d{4})\b/i);
  const last4 = acct ? acct[1].slice(-4) : "";
  if (!last4 && !card) return null;

  const dm =
    block.match(/\bDate\s*[:\-]\s*(\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})/i) ||
    block.match(/\bon\s+(\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})/i) ||
    block.match(/\bon\s+(\d{1,2}[- ][A-Za-z]{3,9}[- ,]+\d{2,4})/i) ||
    block.match(/\b(\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})\b/);
  let day = dm ? parseBankDate(dm[1]) : null;
  const mailDay = istDay(date);
  // An alert is about a recent transaction: ignore a "date" more than 10 days away from the email (a phone number…)
  if (day && Math.abs(new Date(day) - new Date(mailDay)) > 10 * 86400000) day = null;

  const ref =
    block.match(/(?:reference|ref\.?|utr|rrn)\s*(?:no\.?|number|id)?\s*[:\-.]?\s*([A-Z0-9]{6,})/i) ||
    block.match(/\b(?:UPI|IMPS|NEFT|RTGS)\s*(?:txn|ref)?\s*[:\-]?\s*(\d{9,})\b/i);
  const bal = block.match(/(?:available|avl\.?|total available|closing)\s*(?:bal(?:ance)?\.?)[^0-9₹]{0,40}?(?:Rs\.?|INR|₹)\s*([0-9][0-9,]*(?:\.\d{1,2})?)/i);

  // Description: the transaction sentence(s), without the greeting and the help text.
  let desc = block
    .split(/\n\n/)
    .slice(0, 4)
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/(If you did not|Not you\?|For more details|Need Help|Did you know|Assuring you|We're here|Warm Regards|Not you).*$/i, "")
    .trim();
  if (desc.length < 20) desc = String(subject || "").trim() + " — " + desc;
  return {
    deposit: isDebit ? 0 : amount,
    withdrawal: isDebit ? amount : 0,
    last4,
    card: card ? card[1] : "",
    date: new Date(`${day || mailDay}T00:00:00.000Z`),
    dateFromMail: !day,
    reference: ref ? ref[1] : "",
    description: desc.slice(0, 500),
    balance: bal ? num(bal[1]) : null,
  };
}

module.exports = { parseAlert };
