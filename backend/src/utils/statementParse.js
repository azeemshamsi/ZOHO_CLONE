/**
 * Read a bank statement file (CSV / XLS / XLSX, password-protected Excel too) on the server: find the header row,
 * guess the columns (same rules as the browser import in frontend/src/lib/csv.js) and return the transactions with
 * the account number printed in the file. Used by the email auto-import.
 */
const XLSX = require("xlsx");

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      row.push(cell.trim());
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell.trim());
      if (row.some((c) => c !== "")) rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  row.push(cell.trim());
  if (row.some((c) => c !== "")) rows.push(row);
  return rows;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, "0");

// Indian banks write day first. Returns "YYYY-MM-DD" or null.
function parseBankDate(s) {
  if (s === null || s === undefined || s === "") return null;
  if (s instanceof Date && !isNaN(s)) return `${s.getFullYear()}-${pad(s.getMonth() + 1)}-${pad(s.getDate())}`;
  s = String(s).trim();
  if (/^\d{5}(\.\d+)?$/.test(s) && +s > 30000 && +s < 80000) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(+s) * 86400000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  let c = s.match(/^(20\d{2})(\d{2})(\d{2})$/);
  if (c && +c[2] >= 1 && +c[2] <= 12) return `${c[1]}-${c[2]}-${c[3]}`;
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = s.match(/^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2,4})/);
  if (m) {
    if (+m[2] > 12) return null;
    return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${pad(m[2])}-${pad(m[1])}`;
  }
  m = s.match(/^(\d{1,2})[-/ ]([A-Za-z]{3,9})[-/ ,]+(\d{2,4})/);
  if (m) {
    const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mon) return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${pad(mon)}-${pad(m[1])}`;
  }
  m = s.match(/^([A-Za-z]{3,9})[ -](\d{1,2}),?[ -](\d{2,4})/);
  if (m) {
    const mon = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mon) return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${pad(mon)}-${pad(m[2])}`;
  }
  return null;
}

function parseAmount(s) {
  if (s === undefined || s === null) return 0;
  if (typeof s === "number") return s;
  let t = String(s).trim();
  if (!t || t === "-") return 0;
  const neg = /^\(.*\)$/.test(t) || /^-/.test(t) || /\bdr\b/i.test(t);
  t = t.replace(/[^0-9.]/g, "");
  const n = parseFloat(t);
  if (isNaN(n)) return 0;
  return neg ? -n : n;
}

function guessColumns(header) {
  const h = header.map((x) => String(x || "").toLowerCase().trim());
  const find = (re, not) => h.findIndex((x) => re.test(x) && !(not && not.test(x)));
  const drcr = find(/^(cr\s*\/\s*dr|dr\s*\/\s*cr|type|txn type|transaction type|debit\s*\/\s*credit|cr\/dr indicator)$/);
  const deposit = find(/deposit|credit|\bcr\b|money in|paid in/, /\/|indicator|balance/);
  const withdrawal = find(/withdraw|debit|\bdr\b|money out|paid out/, /\/|indicator|balance/);
  const amount = find(/^amount|amount\s*\(|txn amount|transaction amount|^amt/, /balance/);
  const firstDate = find(/date|\bdt\b/);
  const txnDate = find(/(txn|tran|transaction|posting)\.?\s*(date|dt)/);
  const description = find(/narration|description|particular|details|naration/);
  let reference = find(/ref|chq|cheque|utr|instrument/);
  if (reference === -1) reference = find(/remark/); // ICICI corporate: "Tran Remarks"
  return {
    date: txnDate !== -1 ? txnDate : Math.max(firstDate, 0),
    description: description !== -1 ? description : find(/remark/),
    reference: reference === description ? -1 : reference,
    deposit,
    withdrawal,
    amount,
    drcr,
    balance: find(/balance|\bbal\b|closing/, /opening/),
  };
}

function findHeaderRow(rows) {
  const i = rows.findIndex((r) => r.length >= 3 && r.some((c) => /date|\bdt\b/i.test(c)) && r.filter((c) => c !== "").length >= 3);
  return i === -1 ? -1 : i;
}

// Account number printed in the file: "Ac No:019105007866", "Account Number : 50100…", or the file name.
function accountNumberOf(rows, fileName) {
  const re = /(?:a\/?c(?:count)?|account)\s*(?:no\.?|number|num)?\s*[:.\-]?\s*([0-9Xx*]{6,20})/i;
  for (const r of rows.slice(0, 40))
    for (const c of r) {
      const m = String(c || "").match(re);
      if (m && /\d{4}/.test(m[1])) return m[1];
    }
  const f = String(fileName || "").match(/(\d{9,18})/);
  return f ? f[1] : "";
}

function rowsToTransactions(rows) {
  const h = findHeaderRow(rows);
  if (h === -1) return null;
  const map = guessColumns(rows[h]);
  const useAmount = map.deposit === -1 && map.withdrawal === -1 && map.amount !== -1;
  if (!useAmount && map.deposit === -1 && map.withdrawal === -1) return null;
  const out = [];
  for (const r of rows.slice(h + 1)) {
    const date = parseBankDate(r[map.date]);
    if (!date) continue;
    let deposit = 0;
    let withdrawal = 0;
    if (useAmount) {
      const a = parseAmount(r[map.amount]);
      const flag = map.drcr >= 0 ? String(r[map.drcr] || "").trim().toLowerCase() : "";
      if (flag) {
        if (/^(d|dr|debit|withdraw)/.test(flag)) withdrawal = Math.abs(a);
        else deposit = Math.abs(a);
      } else if (a >= 0) deposit = a;
      else withdrawal = -a;
    } else {
      deposit = Math.abs(parseAmount(r[map.deposit]));
      withdrawal = Math.abs(parseAmount(r[map.withdrawal]));
    }
    if (!deposit && !withdrawal) continue; // B/F and summary lines
    const balRaw = map.balance >= 0 ? String(r[map.balance] ?? "").trim() : "";
    out.push({
      date: new Date(`${date}T00:00:00.000Z`),
      description: String(map.description >= 0 ? r[map.description] || "" : "").slice(0, 500),
      reference: String(map.reference >= 0 ? r[map.reference] || "" : "").slice(0, 200),
      deposit,
      withdrawal,
      balance: balRaw && balRaw !== "-" ? parseAmount(balRaw) : null,
    });
  }
  return out;
}

const isZipOrOle = (b) => (b[0] === 0x50 && b[1] === 0x4b) || (b[0] === 0xd0 && b[1] === 0xcf);

/**
 * buffer + file name → { accountNumber, rows } | throws a readable Error.
 * `passwords` are tried in turn for a password-protected Excel file.
 */
async function parseStatement(buffer, fileName, passwords = []) {
  const name = String(fileName || "").toLowerCase();
  if (name.endsWith(".pdf") || buffer.slice(0, 4).toString() === "%PDF")
    throw new Error("PDF statements can't be read automatically — ask the bank to email the statement as CSV or Excel");
  let sheets;
  if (isZipOrOle(buffer) || /\.(xlsx?|xlsm)$/.test(name)) {
    let buf = buffer;
    const oc = require("officecrypto-tool");
    if (oc.isEncrypted(buf)) {
      let opened = null;
      for (const pw of passwords.filter(Boolean)) {
        try {
          opened = await oc.decrypt(buf, { password: pw });
          break;
        } catch {}
      }
      if (!opened) throw new Error(passwords.filter(Boolean).length ? "The statement's password didn't open it — check the file password" : "The statement is password-protected — add its password");
      buf = opened;
    }
    const wb = XLSX.read(buf, { type: "buffer", cellDates: true });
    sheets = wb.SheetNames.map((n) => XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, defval: "" }).map((r) => r.map((c) => String(c ?? "").trim())));
  } else {
    sheets = [parseCsv(buffer.toString("utf8").replace(/^﻿/, ""))];
  }
  for (const rows of sheets) {
    const tx = rowsToTransactions(rows);
    if (tx) return { accountNumber: accountNumberOf(rows, fileName), rows: tx };
  }
  throw new Error("No statement table found in the file (no row with Date / Debit / Credit columns)");
}

module.exports = { parseStatement, parseCsv, parseBankDate, guessColumns };
