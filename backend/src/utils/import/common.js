/**
 * Helpers shared by the Zoho / Tally / spreadsheet importers: header matching, dates, amounts,
 * states, GST treatment and payment terms in the many spellings exports use.
 */
const { STATES } = require("../states");
const { round2 } = require("../http");

const clean = (v) => (v === null || v === undefined ? "" : String(v).replace(/\s+/g, " ").trim());
const key = (h) => clean(h).toLowerCase().replace(/[^a-z0-9%#]+/g, " ").trim();

// First column of `row` whose header matches one of the aliases.
function pick(row, aliases) {
  if (!row) return "";
  if (!row.__keys) Object.defineProperty(row, "__keys", { value: Object.keys(row).map((k) => [key(k), k]), enumerable: false });
  for (const a of aliases) {
    const ka = key(a);
    const hit = row.__keys.find(([k]) => k === ka);
    if (hit && clean(row[hit[1]]) !== "") return row[hit[1]];
  }
  return "";
}
const hasCol = (headers, aliases) => aliases.some((a) => headers.includes(key(a)));

// "1,23,456.50", "(500)", "500 Dr", "1,000.00 Cr", "₹ 99" → number (Dr positive, Cr negative when `drcr`)
function num(v, { drcr = false } = {}) {
  if (typeof v === "number") return v;
  let s = clean(v);
  if (!s) return 0;
  let sign = 1;
  if (/\(.*\)/.test(s)) sign = -1;
  if (drcr && /\bcr\.?$/i.test(s)) sign = -1;
  s = s.replace(/\b(dr|cr)\.?$/i, "").replace(/[^0-9.\-]/g, "");
  const n = parseFloat(s);
  return isNaN(n) ? 0 : sign * n;
}

const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
// Dates as exported by Zoho, Tally, Excel: 2026-04-01, 01/04/2026, 1-Apr-2026, 20260401, Excel serials, Date objects.
function date(v) {
  if (!v && v !== 0) return null;
  if (v instanceof Date) return isNaN(v) ? null : new Date(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate()));
  if (typeof v === "number") {
    if (v > 19000101 && v < 21001231) return date(String(v));
    if (v > 20000 && v < 80000) return new Date(Date.UTC(1899, 11, 30) + v * 86400000); // Excel serial
    return null;
  }
  const s = clean(v);
  let m;
  if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/))) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if ((m = s.match(/^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2,4})$/))) {
    const y = +m[3] < 100 ? 2000 + +m[3] : +m[3];
    return new Date(Date.UTC(y, +m[2] - 1, +m[1])); // Indian day-first
  }
  if ((m = s.match(/^(\d{1,2})[-/ ]([A-Za-z]{3})[A-Za-z]*[-/ ,]+(\d{2,4})$/))) {
    const y = +m[3] < 100 ? 2000 + +m[3] : +m[3];
    const mo = MON[m[2].toLowerCase()];
    if (mo !== undefined) return new Date(Date.UTC(y, mo, +m[1]));
  }
  if ((m = s.match(/^([A-Za-z]{3})[A-Za-z]* (\d{1,2}),? (\d{4})$/))) {
    const mo = MON[m[1].toLowerCase()];
    if (mo !== undefined) return new Date(Date.UTC(+m[3], mo, +m[2]));
  }
  const d = new Date(s);
  return isNaN(d) ? null : new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}
const iso = (d) => (d ? d.toISOString().slice(0, 10) : "");

// State code from "27", "MH", "Maharashtra", "27-Maharashtra", or a GSTIN.
const ABBR = { AN: "35", AP: "37", AR: "12", AS: "18", BR: "10", CH: "04", CG: "22", CT: "22", DN: "26", DD: "26", DL: "07", GA: "30", GJ: "24", HR: "06", HP: "02", JK: "01", JH: "20", KA: "29", KL: "32", LA: "38", LD: "31", MP: "23", MH: "27", MN: "14", ML: "17", MZ: "15", NL: "13", OD: "21", OR: "21", PY: "34", PB: "03", RJ: "08", SK: "11", TN: "33", TS: "36", TG: "36", TR: "16", UP: "09", UK: "05", UT: "05", WB: "19" };
function stateCode(v, gstin = "") {
  const s = clean(v);
  if (/^\d{2}$/.test(s) && STATES.some(([c]) => c === s)) return s;
  if ((/^\d{2}[A-Z]/.test(gstin || "")) && !s) return String(gstin).slice(0, 2);
  const m = s.match(/^(\d{2})\s*[-–]/);
  if (m) return m[1];
  if (ABBR[s.toUpperCase()]) return ABBR[s.toUpperCase()];
  const n = s.toLowerCase().replace(/&/g, "and").replace(/[^a-z]/g, "");
  const hit = STATES.find(([, name]) => name.toLowerCase().replace(/&/g, "and").replace(/[^a-z]/g, "") === n);
  if (hit) return hit[0];
  if (/orissa/.test(n)) return "21";
  if (/pondicherry/.test(n)) return "34";
  if (/delhi/.test(n)) return "07";
  if (gstin && /^\d{2}/.test(gstin)) return String(gstin).slice(0, 2);
  return "";
}

const GSTIN_RX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const gstin = (v) => {
  const s = clean(v).toUpperCase().replace(/\s/g, "");
  return GSTIN_RX.test(s) ? s : "";
};

function gstTreatment(v, hasGstin, country = "") {
  const s = clean(v).toLowerCase();
  if (/overseas|export|foreign/.test(s) || (country && !/india/i.test(country))) return "overseas";
  if (/sez/.test(s)) return "sez";
  if (/consumer/.test(s)) return "consumer";
  if (/unregistered|unreg/.test(s)) return hasGstin ? "registered" : "unregistered";
  if (/regular|registered|business|composition/.test(s)) return hasGstin ? "registered" : "unregistered";
  return hasGstin ? "registered" : "consumer";
}

// "Net 15", "15 Days", "Due on Receipt", 30 → days
function terms(v) {
  const s = clean(v).toLowerCase();
  if (!s) return null;
  if (/receipt|immediate/.test(s)) return 0;
  const m = s.match(/(\d+)/);
  return m ? Math.min(365, +m[1]) : null;
}

function mode(v) {
  const s = clean(v).toLowerCase();
  if (/cash/.test(s)) return "cash";
  if (/upi|gpay|phonepe|paytm/.test(s)) return "upi";
  if (/cheque|check|chq/.test(s)) return "cheque";
  if (/card/.test(s)) return "card";
  if (/neft|rtgs|imps|bank|transfer|wire/.test(s)) return "bank_transfer";
  return s ? "other" : "bank_transfer";
}

const GST_RATES = [0, 0.25, 3, 5, 12, 18, 28];
const snapRate = (r) => GST_RATES.reduce((a, b) => (Math.abs(b - r) < Math.abs(a - r) ? b : a), 0);

module.exports = { clean, key, pick, hasCol, num, date, iso, stateCode, gstin, gstTreatment, terms, mode, snapRate, round2, GST_RATES };
