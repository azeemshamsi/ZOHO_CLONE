/**
 * Read a supplier's bill (text PDF) and pull out what a purchase bill / expense needs:
 * supplier GSTIN and name, bill number and date, taxable value, CGST/SGST/IGST and total.
 * Scanned (image-only) PDFs have no text to read; those come back with `scanned: true`.
 */
const { date: parseDate, snapRate, round2 } = require("./import/common");

async function pdfText(buf) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true, isEvalSupported: false, disableFontFace: true, verbosity: 0 }).promise;
  const lines = [];
  for (let p = 1; p <= Math.min(doc.numPages, 6); p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    // Group text pieces into lines by their y position.
    const rows = new Map();
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const y = Math.round(it.transform[5] / 3) * 3;
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push({ x: it.transform[4], s: it.str });
    }
    for (const y of [...rows.keys()].sort((a, b) => b - a)) lines.push(rows.get(y).sort((a, b) => a.x - b.x).map((r) => r.s).join(" ").replace(/\s+/g, " ").trim());
  }
  return lines.filter(Boolean);
}

const GSTIN_RX = /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g;
const AMT = String.raw`(?:₹|Rs\.?|INR)?\s*(-?[\d,]+(?:\.\d{1,2})?)`;
const num = (s) => Number(String(s || "").replace(/[₹,\s]|Rs\.?|INR/g, "")) || 0;

// The amount on the same line as a label (the last amount on that line, ignoring "18%" style rates).
function amountAfter(lines, rx, { pick = "last" } = {}) {
  const found = [];
  for (const l of lines) {
    if (!rx.test(l)) continue;
    const amts = [...l.replace(/\d+(\.\d+)?\s*%/g, " ").matchAll(new RegExp(AMT, "g"))].map((m) => num(m[1])).filter((n) => Math.abs(n) >= 1);
    if (amts.length) found.push(pick === "max" ? Math.max(...amts) : amts[amts.length - 1]);
  }
  return found;
}

function parseBill(lines, { ownGstins = [] } = {}) {
  const text = lines.join("\n");
  const notes = [];
  const gstins = [...new Set(text.match(GSTIN_RX) || [])];
  const own = new Set(ownGstins.filter(Boolean).map((g) => g.toUpperCase()));
  const supplierGstin = gstins.find((g) => !own.has(g)) || "";
  const buyerGstin = gstins.find((g) => own.has(g)) || "";
  if (gstins.length && !supplierGstin) notes.push("Only your own GSTIN was found");

  // Supplier name: a line near the supplier GSTIN, or the first prominent line at the top.
  const skip = /^(tax invoice|invoice|bill of supply|original|duplicate|triplicate|for recipient|page \d|e-?invoice|irn|ack|gstin|pan|bill to|ship to|details|cash memo|receipt)\b/i;
  let supplierName = "";
  // Best guess first: a business-looking name above the "Bill to" block.
  const billTo = lines.findIndex((l) => /^(bill(ed)? to|buyer|customer|consignee|ship to)\b/i.test(l));
  const top = lines.slice(0, billTo > 0 ? billTo : 15);
  supplierName = top.find((l) => /\b(private limited|pvt\.?\s*ltd|limited|ltd\.?|llp|enterprises|traders|industries|company|& co\b|solutions|services|exports|impex|handicrafts|agency|corporation|inc\.?)\b/i.test(l) && !skip.test(l) && !/gstin|pan/i.test(l)) || "";
  const gi = lines.findIndex((l) => supplierGstin && l.includes(supplierGstin));
  for (let i = Math.max(0, gi - 4); i < gi && !supplierName && gi > 0; i++) if (lines[i] && !skip.test(lines[i]) && /[A-Za-z]{3}/.test(lines[i]) && !/\d{6}|road|street|nagar|sector|floor|tower|phone|email|@/i.test(lines[i])) supplierName = lines[i];
  if (!supplierName) supplierName = lines.slice(0, 8).find((l) => !skip.test(l) && /[A-Za-z]{3}/.test(l) && !/\d{4}|@|www\.|invoice/i.test(l)) || "";
  supplierName = supplierName.replace(/\s*(private limited|pvt\.? ltd\.?|llp|limited)\b.*$/i, (m) => m.split(/\s{2,}/)[0]).slice(0, 120).trim();

  // Bill number and date
  let billNumber = "";
  for (const l of lines) {
    const m = l.match(/(?:invoice|inv|bill|document)\s*(?:no\.?|number|num|#)\s*[:.\-]?\s*([A-Z0-9][A-Z0-9\/\-_.]{1,30})/i);
    if (m && !/date/i.test(m[1])) {
      billNumber = m[1].replace(/[.,]$/, "");
      break;
    }
  }
  let date = null;
  const dateRx = /(\d{1,2}[\/\-. ](?:\d{1,2}|[A-Za-z]{3,9})[\/\-. ,]+\d{2,4}|\d{4}-\d{2}-\d{2})/;
  for (const l of lines) {
    if (!/date/i.test(l) || /due|supply|ack|order|delivery/i.test(l)) continue;
    const m = l.match(dateRx);
    if (m && (date = parseDate(m[1].replace(/,/g, "")))) break;
  }
  if (!date) for (const l of lines) {
    const m = l.match(dateRx);
    if (m && (date = parseDate(m[1].replace(/,/g, "")))) break;
  }
  let dueDate = null;
  for (const l of lines) {
    if (!/due/i.test(l)) continue;
    const m = l.match(dateRx);
    if (m && (dueDate = parseDate(m[1].replace(/,/g, "")))) break;
  }

  // Amounts
  const cgst = Math.max(0, ...amountAfter(lines, /\bC\.?GST\b|central tax/i));
  const sgst = Math.max(0, ...amountAfter(lines, /\b(S|UT)\.?GST\b|state tax|ut tax/i));
  const igst = Math.max(0, ...amountAfter(lines, /\bI\.?GST\b|integrated (gst|tax)/i));
  const totals = amountAfter(lines, /grand total|invoice total|total amount|amount payable|net payable|total payable|total value|amount due|balance due|\btotal\b/i, { pick: "max" });
  let total = totals.length ? Math.max(...totals) : 0;
  let taxable = Math.max(0, ...amountAfter(lines, /taxable (value|amount)|sub\s?-?total|total before tax|assessable value|net amount/i));
  let tax = round2(igst || cgst + sgst);
  if (!taxable && total && tax) taxable = round2(total - tax);
  if (!total && taxable) total = round2(taxable + tax);
  if (taxable && total && tax > total) {
    notes.push("Tax amounts looked wrong and were ignored");
    tax = 0;
  }
  const rate = taxable && tax ? snapRate((tax / taxable) * 100) : 0;
  const adjustment = total ? round2(total - taxable - round2((taxable * rate) / 100)) : 0;

  const hsn = (text.match(/\b(?:HSN|SAC)[^\d]{0,20}(\d{4,8})\b/i) || [])[1] || "";
  const placeOfSupply = (supplierGstin || "").slice(0, 2);
  const interState = igst > 0 || (!cgst && !sgst && tax > 0);
  if (!supplierGstin) notes.push("No supplier GSTIN found");
  if (!billNumber) notes.push("Bill number not found");
  if (!date) notes.push("Bill date not found");
  if (!total) notes.push("Total not found");
  if (Math.abs(adjustment) > 2) notes.push(`Taxable + GST differs from the total by ₹${adjustment} (round-off, other charges or several GST rates) — check the lines`);
  return { supplierGstin, buyerGstin, supplierName, billNumber, date, dueDate, taxable: round2(taxable), cgst, sgst, igst, tax, total: round2(total), rate, adjustment, hsn, interState, placeOfSupply, notes };
}

module.exports = { pdfText, parseBill };
