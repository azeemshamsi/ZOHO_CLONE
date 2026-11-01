// Small CSV reader for bank statements (handles quotes, commas inside quotes, CRLF).
export function parseCsv(text) {
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

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12, january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
const pad = (n) => String(n).padStart(2, "0");

// Indian banks write day first. Returns "YYYY-MM-DD" or null.
export function parseBankDate(s) {
  if (s === null || s === undefined || s === "") return null;
  s = String(s).trim();
  // Excel date stored as a plain number (days since 1899-12-30), e.g. 46328
  if (/^\d{5}(\.\d+)?$/.test(s) && +s > 30000 && +s < 80000) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(+s) * 86400000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  // 20261102
  let c = s.match(/^(20\d{2})(\d{2})(\d{2})$/);
  if (c && +c[2] >= 1 && +c[2] <= 12) return `${c[1]}-${c[2]}-${c[3]}`;
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = s.match(/^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    if (+m[2] > 12) return null;
    return `${y}-${pad(m[2])}-${pad(m[1])}`;
  }
  m = s.match(/^(\d{1,2})[-/ ]([A-Za-z]{3,9})[-/ ,]+(\d{2,4})/);
  if (m) {
    const mon = MONTHS[m[2].toLowerCase()] || MONTHS[m[2].slice(0, 3).toLowerCase()];
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    if (mon) return `${y}-${pad(mon)}-${pad(m[1])}`;
  }
  // "Nov 02, 2026"
  m = s.match(/^([A-Za-z]{3,9})[ -](\d{1,2}),?[ -](\d{2,4})/);
  if (m) {
    const mon = MONTHS[m[1].toLowerCase()] || MONTHS[m[1].slice(0, 3).toLowerCase()];
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    if (mon) return `${y}-${pad(mon)}-${pad(m[2])}`;
  }
  return null;
}

// "1,23,456.78", "₹ 500", "(250.00)", "500 Cr" -> number
export function parseAmount(s) {
  if (s === undefined || s === null) return 0;
  let t = String(s).trim();
  if (!t || t === "-") return 0;
  const neg = /^\(.*\)$/.test(t) || /^-/.test(t) || /\bdr\b/i.test(t);
  t = t.replace(/[^0-9.]/g, "");
  const n = parseFloat(t);
  if (isNaN(n)) return 0;
  return neg ? -n : n;
}

// Guess which column is which from the header names (HDFC, ICICI, SBI, Axis, Kotak, Yes, IDFC… layouts).
export function guessColumns(header) {
  const h = header.map((x) => String(x || "").toLowerCase().trim());
  const find = (re, not) => h.findIndex((x) => re.test(x) && !(not && not.test(x)));
  const drcr = find(/^(cr\s*\/\s*dr|dr\s*\/\s*cr|type|txn type|transaction type|debit\s*\/\s*credit|cr\/dr indicator)$/);
  const deposit = find(/deposit|credit|\bcr\b|money in|paid in/, /\/|indicator|balance/);
  const withdrawal = find(/withdraw|debit|\bdr\b|money out|paid out/, /\/|indicator|balance/);
  const amount = find(/^amount|amount\s*\(|txn amount|transaction amount|^amt/, /balance/);
  const firstDate = find(/date|\bdt\b/);
  const txnDate = find(/(txn|tran|transaction|posting)\.?\s*(date|dt)/);
  return {
    date: txnDate !== -1 ? txnDate : Math.max(firstDate, 0),
    description: find(/narration|description|particular|remark|details|naration/),
    reference: find(/ref|chq|cheque|utr|instrument/),
    deposit,
    withdrawal,
    amount,
    drcr,
    balance: find(/balance|\bbal\b|closing/, /opening/),
  };
}

// The header is the first row that looks like column names (has a "date"-ish cell).
export function findHeaderRow(rows) {
  const i = rows.findIndex((r) => r.length >= 3 && r.some((c) => /date|\bdt\b/i.test(c)) && r.filter((c) => c !== "").length >= 3);
  return i === -1 ? 0 : i;
}
