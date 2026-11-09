/**
 * Phone numbers: Indian numbers are matched on their last 10 digits (orders store "+91 98…", "098…", "98…").
 * WhatsApp wants the full international number without "+": a bare 10-digit number gets 91.
 */
const digits = (p) => String(p || "").replace(/\D/g, "");
const last10 = (p) => {
  const d = digits(p);
  return d.length >= 10 ? d.slice(-10) : "";
};
function toWa(p, cc = "91") {
  let d = digits(p);
  if (!d) return "";
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  if (d.length === 10) return cc + d;
  if (d.length === 12 && d.startsWith("91")) return d;
  return d.length >= 11 && d.length <= 15 ? d : "";
}
const samePhone = (a, b) => !!last10(a) && last10(a) === last10(b);
const cleanEmail = (e) => {
  const s = String(e || "").trim().toLowerCase();
  const m = s.match(/<([^>]+)>/);
  const x = m ? m[1] : s;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x) ? x : "";
};

module.exports = { digits, last10, toWa, samePhone, cleanEmail };
