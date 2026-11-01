const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2 });
const num = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmts = {};
// Format in a currency (default ₹). Unknown codes fall back to "CODE 1,234.00".
export const money = (n, cur = "INR") => {
  if (!cur || cur === "INR") return inr.format(Number(n) || 0);
  try {
    fmts[cur] = fmts[cur] || new Intl.NumberFormat("en-IN", { style: "currency", currency: cur, minimumFractionDigits: 2 });
    return fmts[cur].format(Number(n) || 0);
  } catch {
    return `${cur} ${num.format(Number(n) || 0)}`;
  }
};
export const amount = (n) => num.format(Number(n) || 0);

export const date = (d) =>
  d ? new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "";

// yyyy-mm-dd for <input type="date">
export const isoDate = (d = new Date()) => {
  const x = new Date(d);
  return new Date(x.getTime() - x.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};

export const addDays = (d, n) => {
  const x = new Date(d);
  x.setDate(x.getDate() + Number(n || 0));
  return isoDate(x);
};

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Indian numbering in words for invoice totals.
const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
function two(n) {
  return n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? " " + ONES[n % 10] : ""}`;
}
function three(n) {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return [h ? `${ONES[h]} Hundred` : "", r ? two(r) : ""].filter(Boolean).join(" ");
}
export function inWords(value) {
  const n = Math.floor(Math.abs(value));
  const paise = Math.round((Math.abs(value) - n) * 100);
  if (n === 0 && paise === 0) return "Zero Rupees Only";
  const parts = [];
  const crore = Math.floor(n / 10000000);
  const lakh = Math.floor((n % 10000000) / 100000);
  const thousand = Math.floor((n % 100000) / 1000);
  const rest = n % 1000;
  if (crore) parts.push(`${three(crore)} Crore`);
  if (lakh) parts.push(`${two(lakh)} Lakh`);
  if (thousand) parts.push(`${two(thousand)} Thousand`);
  if (rest) parts.push(three(rest));
  let s = `Indian Rupee ${parts.join(" ") || "Zero"}`;
  if (paise) s += ` and ${two(paise)} Paise`;
  return `${s} Only`;
}
