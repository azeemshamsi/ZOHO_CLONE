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

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, "0");

// Indian banks write day first. Returns "YYYY-MM-DD" or null.
export function parseBankDate(s) {
  if (!s) return null;
  s = String(s).trim();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = s.match(/^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    if (+m[2] > 12) return null;
    return `${y}-${pad(m[2])}-${pad(m[1])}`;
  }
  m = s.match(/^(\d{1,2})[-/ ]([A-Za-z]{3,4})[-/ ,]+(\d{2,4})/);
  if (m && MONTHS[m[2].toLowerCase()]) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${pad(MONTHS[m[2].toLowerCase()])}-${pad(m[1])}`;
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

// Guess which column is which from the header names.
export function guessColumns(header) {
  const find = (re) => header.findIndex((h) => re.test(h.toLowerCase()));
  const amountIdx = find(/^amount|amount \(|txn amount|transaction amount/);
  return {
    date: Math.max(find(/(txn|transaction|value|posting)?\s*date/), 0),
    description: find(/narration|description|particular|remark|details/),
    reference: find(/ref|chq|cheque|utr/),
    deposit: find(/deposit|credit|\bcr\b|money in/),
    withdrawal: find(/withdraw|debit|\bdr\b|money out/),
    amount: amountIdx,
  };
}

// The header is the first row that looks like column names (has a "date"-ish cell).
export function findHeaderRow(rows) {
  const i = rows.findIndex((r) => r.some((c) => /date/i.test(c)) && r.length >= 3);
  return i === -1 ? 0 : i;
}
