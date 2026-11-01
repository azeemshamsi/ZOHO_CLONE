/**
 * Server-side PDFs of documents (GST invoice layout) for email attachments and downloads.
 */
const path = require("path");
const PDFDocument = require("pdfkit");
const { STATES } = require("./states");

const FONT = path.join(__dirname, "..", "..", "assets", "fonts", "DejaVuSans.ttf");
const BOLD = path.join(__dirname, "..", "..", "assets", "fonts", "DejaVuSans-Bold.ttf");
const BRAND = "#4f46e5";
const MUTED = "#6b7280";
const LINE = "#e5e7eb";

const inr = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (n, cur) => (cur && cur !== "INR" ? `${cur} ${inr.format(Number(n) || 0)}` : `₹${inr.format(Number(n) || 0)}`);
const num = (n) => inr.format(Number(n) || 0);
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }) : "");
const stateName = (c) => (STATES.find(([k]) => k === c) || [c, c])[1];

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
const two = (n) => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? " " + ONES[n % 10] : ""}`);
const three = (n) => [Math.floor(n / 100) ? `${ONES[Math.floor(n / 100)]} Hundred` : "", n % 100 ? two(n % 100) : ""].filter(Boolean).join(" ");
function inWords(value) {
  const n = Math.floor(Math.abs(value));
  const paise = Math.round((Math.abs(value) - n) * 100);
  if (!n && !paise) return "Zero Rupees Only";
  const parts = [];
  const crore = Math.floor(n / 10000000);
  if (crore) parts.push(`${crore >= 1000 ? inWords(crore).replace(/^Indian Rupee | Only$/g, "") : three(crore)} Crore`);
  if (Math.floor((n % 10000000) / 100000)) parts.push(`${two(Math.floor((n % 10000000) / 100000))} Lakh`);
  if (Math.floor((n % 100000) / 1000)) parts.push(`${two(Math.floor((n % 100000) / 1000))} Thousand`);
  if (n % 1000) parts.push(three(n % 1000));
  return `Indian Rupee ${parts.join(" ") || "Zero"}${paise ? ` and ${two(paise)} Paise` : ""} Only`;
}

const addrLines = (a = {}) => [a.street, a.city, [stateName(a.state), a.pincode].filter(Boolean).join(" "), a.country].filter((x) => x && x.trim());

function toBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}

function setup() {
  const doc = new PDFDocument({ size: "A4", margin: 40, bufferPages: true });
  doc.registerFont("r", FONT);
  doc.registerFont("b", BOLD);
  doc.font("r");
  return doc;
}

function header(doc, org, title, number) {
  const L = 40;
  const W = doc.page.width - 80;
  doc.font("b").fontSize(15).fillColor("#111827").text(org.name, L, 40, { width: W * 0.6 });
  doc.font("r").fontSize(8.5).fillColor(MUTED);
  const lines = [...addrLines(org.address), org.gstin && `GSTIN ${org.gstin}`, [org.phone, org.email].filter(Boolean).join(" · ")].filter(Boolean);
  lines.forEach((l) => doc.text(l, L, doc.y, { width: W * 0.6 }));
  const leftBottom = doc.y;
  doc.font("b").fontSize(18).fillColor(BRAND).text(title, L, 40, { width: W, align: "right" });
  doc.font("r").fontSize(10).fillColor("#111827").text(`# ${number}`, L, doc.y + 2, { width: W, align: "right" });
  doc.y = Math.max(leftBottom, doc.y) + 14;
  doc.moveTo(L, doc.y).lineTo(L + W, doc.y).strokeColor(LINE).lineWidth(1).stroke();
  doc.y += 12;
}

// Two columns: party on the left, key/value facts on the right.
function partyBlock(doc, label, partyName, gstin, address, facts, shipTo) {
  const L = 40;
  const W = doc.page.width - 80;
  const top = doc.y;
  const ship = shipTo && (shipTo.street || shipTo.city || shipTo.pincode);
  const colW = ship ? W * 0.27 : W * 0.5;
  doc.font("r").fontSize(8).fillColor(MUTED).text(label.toUpperCase(), L, top);
  doc.font("b").fontSize(11).fillColor("#111827").text(partyName, L, doc.y + 2, { width: colW });
  doc.font("r").fontSize(8.5).fillColor(MUTED);
  addrLines(address).forEach((l) => doc.text(l, L, doc.y, { width: colW }));
  if (gstin) doc.text(`GSTIN ${gstin}`, L, doc.y, { width: colW });
  let leftEnd = doc.y;
  if (ship) {
    const X = L + W * 0.29;
    doc.font("r").fontSize(8).fillColor(MUTED).text("SHIP TO", X, top);
    doc.font("b").fontSize(11).fillColor("#111827").text(shipTo.name || partyName, X, doc.y + 2, { width: colW });
    doc.font("r").fontSize(8.5).fillColor(MUTED);
    addrLines(shipTo).forEach((l) => doc.text(l, X, doc.y, { width: colW }));
    if (shipTo.phone) doc.text(`Phone ${shipTo.phone}`, X, doc.y, { width: colW });
    leftEnd = Math.max(leftEnd, doc.y);
  }
  let y = top;
  const fx = ship ? 0.6 : 0.55;
  for (const [k, v] of facts.filter(([, v]) => v)) {
    doc.font("r").fontSize(9).fillColor(MUTED).text(k, L + W * fx, y, { width: W * (0.77 - fx + 0.05) });
    doc.font("r").fontSize(9).fillColor("#111827").text(v, L + W * 0.77, y, { width: W * 0.23, align: "right" });
    y += 15;
  }
  doc.y = Math.max(leftEnd, y) + 14;
}

function itemTable(doc, items, inter) {
  const L = 40;
  const W = doc.page.width - 80;
  const cols = [
    ["#", 0.05, "left"],
    ["Item & Description", 0.34, "left"],
    ["HSN/SAC", 0.1, "left"],
    ["Qty", 0.08, "right"],
    ["Rate", 0.12, "right"],
    ["Disc%", 0.09, "right"],
    [inter ? "IGST" : "GST", 0.08, "right"],
    ["Amount", 0.14, "right"],
  ];
  const xs = [];
  let x = L;
  for (const c of cols) {
    xs.push(x);
    x += c[1] * W;
  }
  const head = (y) => {
    doc.rect(L, y, W, 20).fill("#f3f4f6");
    doc.font("b").fontSize(8).fillColor("#374151");
    cols.forEach((c, i) => doc.text(c[0], xs[i] + 4, y + 6, { width: c[1] * W - 8, align: c[2] }));
    return y + 24;
  };
  let y = head(doc.y);
  items.forEach((l, idx) => {
    const desc = [l.name, l.description].filter(Boolean).join("\n");
    doc.font("r").fontSize(8.5);
    const h = Math.max(doc.heightOfString(desc, { width: cols[1][1] * W - 8 }), 10) + 8;
    if (y + h > doc.page.height - 120) {
      doc.addPage();
      y = head(40);
    }
    const cells = [String(idx + 1), desc, l.hsnSac || "", `${l.quantity}${l.unit ? " " + l.unit : ""}`, num(l.rate), l.discount ? String(l.discount) : "", `${l.taxRate}%`, num(l.amount)];
    doc.fillColor("#111827");
    cells.forEach((v, i) => doc.font(i === 1 ? "r" : "r").fontSize(8.5).text(v, xs[i] + 4, y, { width: cols[i][1] * W - 8, align: cols[i][2] }));
    y += h;
    doc.moveTo(L, y - 3).lineTo(L + W, y - 3).strokeColor(LINE).lineWidth(0.5).stroke();
  });
  doc.y = y + 6;
}

function totals(doc, rows) {
  const L = 40;
  const W = doc.page.width - 80;
  const x = L + W * 0.55;
  const w = W * 0.45;
  let y = doc.y;
  if (y + rows.length * 16 > doc.page.height - 60) {
    doc.addPage();
    y = 40;
  }
  for (const [k, v, strong] of rows) {
    if (strong) {
      doc.rect(x, y - 3, w, 18).fill("#eef2ff");
    }
    doc.font(strong ? "b" : "r").fontSize(strong ? 10 : 9).fillColor(strong ? "#111827" : "#374151");
    doc.text(k, x + 6, y, { width: w * 0.55 });
    doc.text(v, x + w * 0.55, y, { width: w * 0.45 - 6, align: "right" });
    y += 18;
  }
  doc.y = y + 6;
}

function footerNotes(doc, total, notes, terms, cur = "INR", rate = 1) {
  const L = 40;
  const W = doc.page.width - 80;
  if (total !== null) {
    doc.font("r").fontSize(8).fillColor(MUTED).text("Total in words", L, doc.y);
    const words = cur && cur !== "INR" ? inWords(total).replace("Indian Rupee", cur).replace("Paise", "Cents") : inWords(total);
    doc.font("b").fontSize(9).fillColor("#111827").text(words, L, doc.y + 1, { width: W });
    if (cur && cur !== "INR") doc.font("r").fontSize(8).fillColor(MUTED).text(`Amounts in ${cur}. Exchange rate 1 ${cur} = ₹${rate}`, L, doc.y + 2, { width: W });
    doc.y += 8;
  }
  for (const [label, text] of [
    ["Notes", notes],
    ["Terms & Conditions", terms],
  ]) {
    if (!text) continue;
    doc.font("r").fontSize(8).fillColor(MUTED).text(label, L, doc.y + 4);
    doc.font("r").fontSize(8.5).fillColor("#374151").text(text, L, doc.y + 1, { width: W });
  }
}

function pageNumbers(doc, org) {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    const m = doc.page.margins.bottom;
    doc.page.margins.bottom = 0; // writing in the margin must not start a new page
    doc.font("r").fontSize(7.5).fillColor(MUTED).text(`${org.name} · Page ${i + 1} of ${range.count}`, 40, doc.page.height - 30, { width: doc.page.width - 80, align: "center", lineBreak: false });
    doc.page.margins.bottom = m;
  }
}

/**
 * kind: invoice | quote | salesOrder | creditNote | purchaseOrder | vendorCredit | bill
 * meta: { title, number, partyLabel, facts: [[label, value]], balance }
 */
// IRN, acknowledgement and the IRP's signed QR code (e-invoice), plus the e-way bill number.
async function gstBlock(doc, d) {
  const e = d.einvoice || {};
  const w = d.eway || {};
  const hasE = e.status === "generated" && e.irn;
  const hasW = w.status === "generated" && w.ewbNo;
  if (!hasE && !hasW) return;
  const L = 40;
  const W = doc.page.width - 80;
  const top = doc.y;
  let qrH = 0;
  if (hasE && e.signedQr) {
    const png = await require("qrcode").toBuffer(e.signedQr, { errorCorrectionLevel: "M", margin: 1, width: 300 });
    doc.image(png, L + W - 92, top, { width: 92 });
    qrH = 96;
  }
  doc.font("r").fontSize(8).fillColor(MUTED);
  let y = top;
  const line = (k, v) => {
    doc.font("r").fillColor(MUTED).text(k, L, y, { continued: true }).font("b").fillColor("#111827").text(` ${v}`, { width: W - 110 });
    y = doc.y + 2;
  };
  if (hasE) {
    line("IRN:", e.irn);
    line("Ack No:", e.ackNo);
    line("Ack Date:", e.ackDate ? new Date(e.ackDate).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "");
  }
  if (hasW) line("E-Way Bill No:", `${w.ewbNo}${w.validUpto ? `  (valid till ${fmtDate(w.validUpto)})` : ""}`);
  doc.y = Math.max(y, top + qrH) + 8;
}

async function documentPdf(org, d, meta) {
  const doc = setup();
  header(doc, org, meta.title, meta.number);
  await gstBlock(doc, d);
  const party = d.vendorName ? "vendor" : "customer";
  partyBlock(doc, meta.partyLabel, d[`${party}Name`], d[`${party}Gstin`], d.billingAddress, [
    ...meta.facts,
    ["Place of Supply", d.placeOfSupply ? `${stateName(d.placeOfSupply)} (${d.placeOfSupply})` : ""],
  ], d.vendorName ? null : d.shipTo);
  itemTable(doc, d.lineItems || [], d.isInterState);
  const rows = [["Sub Total", num(d.subTotal)]];
  if (d.isInterState) rows.push(["IGST", num(d.igst)]);
  else {
    rows.push(["CGST", num(d.cgst)]);
    rows.push(["SGST", num(d.sgst)]);
  }
  if (d.shippingCharge) rows.push(["Shipping Charges", num(d.shippingCharge)]);
  if (d.adjustment) rows.push(["Adjustment", num(d.adjustment)]);
  rows.push(["Total", money(d.total, d.currency), true]);
  if (meta.paid) rows.push(["Payments / Credits", `(-) ${num(meta.paid)}`]);
  if (meta.balance !== undefined) rows.push([meta.balanceLabel || "Balance Due", money(meta.balance, d.currency), true]);
  totals(doc, rows);
  footerNotes(doc, d.total, d.customerNotes, d.terms, d.currency, d.exchangeRate);
  pageNumbers(doc, org);
  return toBuffer(doc);
}

async function receiptPdf(org, p, { title, partyLabel, party, appliedLabel, applied }) {
  const doc = setup();
  header(doc, org, title, p.paymentNumber);
  const L = 40;
  const W = doc.page.width - 80;
  partyBlock(doc, partyLabel, party, "", {}, [
    ["Payment Date", fmtDate(p.date)],
    ["Payment Mode", { cash: "Cash", bank_transfer: "Bank Transfer", upi: "UPI", cheque: "Cheque", card: "Card", other: "Other" }[p.mode] || p.mode],
    ["Reference#", p.reference],
  ]);
  doc.rect(L, doc.y, W, 44).fill("#eef2ff");
  doc.font("r").fontSize(9).fillColor(MUTED).text("Amount Received", L + 12, doc.y + 8);
  doc.font("b").fontSize(18).fillColor(BRAND).text(money(p.amount, p.currency), L + 12, doc.y + 2);
  doc.y += 18;
  doc.font("r").fontSize(8.5).fillColor("#374151").text(inWords(p.amount), L, doc.y, { width: W });
  doc.y += 12;
  if (applied.length) {
    doc.font("b").fontSize(10).fillColor("#111827").text(`Payment for`, L, doc.y);
    doc.y += 4;
    const y0 = doc.y;
    doc.rect(L, y0, W, 18).fill("#f3f4f6");
    doc.font("b").fontSize(8).fillColor("#374151").text(appliedLabel, L + 6, y0 + 5).text("Amount Applied", L, y0 + 5, { width: W - 6, align: "right" });
    let y = y0 + 22;
    for (const a of applied) {
      doc.font("r").fontSize(9).fillColor("#111827").text(a.number, L + 6, y).text(num(a.amount), L, y, { width: W - 6, align: "right" });
      y += 16;
    }
    doc.y = y + 4;
  }
  if (p.unusedAmount) doc.font("r").fontSize(9).fillColor(MUTED).text(`Excess amount kept as credit: ${money(p.unusedAmount)}`, L, doc.y);
  if (p.notes) doc.font("r").fontSize(8.5).fillColor("#374151").text(p.notes, L, doc.y + 8, { width: W });
  pageNumbers(doc, org);
  return toBuffer(doc);
}

module.exports = { documentPdf, receiptPdf, inWords, money, fmtDate };
