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

function setup(size = "A4") {
  // A5: narrower margins so a normal invoice still fits one page.
  const doc = new PDFDocument({ size, margin: size === "A5" ? 22 : 40, bufferPages: true });
  doc.registerFont("r", FONT);
  doc.registerFont("b", BOLD);
  doc.font("r");
  return doc;
}

function header(doc, org, title, number) {
  const L = doc.page.margins.left;
  const W = doc.page.width - 2 * doc.page.margins.left;
  doc.font("b").fontSize(15).fillColor("#111827").text(org.name, L, doc.page.margins.top, { width: W * 0.6 });
  doc.font("r").fontSize(8.5).fillColor(MUTED);
  const lines = [...addrLines(org.address), org.gstin && `GSTIN ${org.gstin}`, [org.phone, org.email].filter(Boolean).join(" · ")].filter(Boolean);
  lines.forEach((l) => doc.text(l, L, doc.y, { width: W * 0.6 }));
  const leftBottom = doc.y;
  doc.font("b").fontSize(18).fillColor(BRAND).text(title, L, doc.page.margins.top, { width: W, align: "right" });
  doc.font("r").fontSize(10).fillColor("#111827").text(`# ${number}`, L, doc.y + 2, { width: W, align: "right" });
  doc.y = Math.max(leftBottom, doc.y) + 14;
  doc.moveTo(L, doc.y).lineTo(L + W, doc.y).strokeColor(LINE).lineWidth(1).stroke();
  doc.y += 12;
}

// Two columns: party on the left, key/value facts on the right.
function partyBlock(doc, label, partyName, gstin, address, facts, shipTo) {
  const L = doc.page.margins.left;
  const W = doc.page.width - 2 * doc.page.margins.left;
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
    y += doc.page.width < 500 ? 12.5 : 15;
  }
  doc.y = Math.max(leftEnd, y) + (doc.page.width < 500 ? 8 : 14);
}

function itemTable(doc, items, inter) {
  const L = doc.page.margins.left;
  const W = doc.page.width - 2 * doc.page.margins.left;
  // Disc% only when a line has a discount; its room goes to the other columns (A5 needs it for HSN and amounts).
  const anyDisc = items.some((l) => Number(l.discount) > 0);
  const a5 = doc.page.width < 500;
  const cols = (
    anyDisc
      ? [["#", 0.05, "left", "no"], ["Item & Description", 0.34, "left", "desc"], ["HSN/SAC", 0.1, "left", "hsn"], ["Qty", 0.08, "right", "qty"], ["Rate", 0.12, "right", "rate"], ["Disc%", 0.09, "right", "disc"], [inter ? "IGST" : "GST", 0.08, "right", "gst"], ["Amount", 0.14, "right", "amt"]]
      : a5
        ? [["#", 0.05, "left", "no"], ["Item & Description", 0.3, "left", "desc"], ["HSN/SAC", 0.15, "left", "hsn"], ["Qty", 0.1, "right", "qty"], ["Rate", 0.14, "right", "rate"], [inter ? "IGST" : "GST", 0.08, "right", "gst"], ["Amount", 0.18, "right", "amt"]]
        : [["#", 0.05, "left", "no"], ["Item & Description", 0.39, "left", "desc"], ["HSN/SAC", 0.11, "left", "hsn"], ["Qty", 0.08, "right", "qty"], ["Rate", 0.13, "right", "rate"], [inter ? "IGST" : "GST", 0.09, "right", "gst"], ["Amount", 0.15, "right", "amt"]]
  );
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
    // Item name a touch smaller on A5; SKU under it (unless the description already carries it).
    const nameFs = doc.page.width < 500 ? 7.8 : 8.5;
    const skuLine = l.sku && !String(l.description || "").includes(l.sku) ? `SKU: ${l.sku}` : "";
    const desc = [l.name, l.description, skuLine].filter(Boolean).join("\n");
    doc.font("r").fontSize(nameFs);
    const h = Math.max(doc.heightOfString(desc, { width: cols[1][1] * W - 8 }), doc.font("r").fontSize(8.5).heightOfString(`${l.quantity}${l.unit ? " " + l.unit : ""}`, { width: cols[3][1] * W - 8 }), 10) + (doc.page.width < 500 ? 5 : 8);
    if (y + h > doc.page.height - 120) {
      doc.addPage();
      y = head(doc.page.margins.top);
    }
    const val = { no: String(idx + 1), desc, hsn: l.hsnSac || "", qty: `${l.quantity}${l.unit ? " " + l.unit : ""}`, rate: num(l.rate), disc: l.discount ? String(l.discount) : "", gst: `${l.taxRate}%`, amt: num(l.amount) };
    doc.fillColor("#111827");
    cols.forEach((c, i) => doc.font("r").fontSize(c[3] === "desc" ? nameFs : 8.5).text(val[c[3]], xs[i] + 4, y, { width: c[1] * W - 8, align: c[2] }));
    y += h;
    doc.moveTo(L, y - 3).lineTo(L + W, y - 3).strokeColor(LINE).lineWidth(0.5).stroke();
  });
  doc.y = y + 6;
}

function totals(doc, rows) {
  const L = doc.page.margins.left;
  const W = doc.page.width - 2 * doc.page.margins.left;
  const x = L + W * 0.55;
  const w = W * 0.45;
  let y = doc.y;
  if (y + rows.length * 16 > doc.page.height - 60) {
    doc.addPage();
    y = doc.page.margins.top;
  }
  for (const [k, v, strong] of rows) {
    if (strong) {
      doc.rect(x, y - 3, w, 18).fill("#eef2ff");
    }
    doc.font(strong ? "b" : "r").fontSize(strong ? 10 : 9).fillColor(strong ? "#111827" : "#374151");
    doc.text(k, x + 6, y, { width: w * 0.55 });
    doc.text(v, x + w * 0.55, y, { width: w * 0.45 - 6, align: "right" });
    y += doc.page.width < 500 ? 15 : 18;
  }
  doc.y = y + 6;
}

function footerNotes(doc, total, notes, terms, cur = "INR", rate = 1) {
  const L = doc.page.margins.left;
  const W = doc.page.width - 2 * doc.page.margins.left;
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
    // Keep a block together on this page, in smaller type if that's what it takes (down to 6 pt); only a block
    // that can't fit even then starts a new page.
    const room = doc.page.height - doc.page.margins.bottom - 4 - doc.y;
    let fs = 8.5;
    const hOf = (f) => (doc.font("r").fontSize(f), doc.heightOfString(text, { width: W }) + f + 6);
    while (fs > 6 && hOf(fs) > room) fs -= 0.5;
    if (hOf(fs) > room && hOf(8.5) < doc.page.height / 2) {
      fs = 8.5;
      doc.addPage();
      doc.y = doc.page.margins.top;
    }
    doc.font("r").fontSize(Math.min(8, fs)).fillColor(MUTED).text(label, L, doc.y + 4, { lineBreak: false });
    doc.y += Math.min(8, fs) + 2;
    doc.font("r").fontSize(fs).fillColor("#374151").text(text, L, doc.y + 1, { width: W });
  }
}

// "For <company>", the signature / stamp, and "Authorised Signatory" at the bottom right (like Tally).
function signatory(doc, org) {
  const W = 200;
  const x = doc.page.width - doc.page.margins.right - W;
  const compact = doc.page.width < 500; // A5
  const need = compact ? 74 : 92;
  if (doc.y + need > doc.page.height - doc.page.margins.bottom) doc.addPage();
  let y = doc.y + (compact ? 6 : 14);
  doc.font("b").fontSize(9).fillColor("#111827").text(`For ${org.name}`, x, y, { width: W, align: "right" });
  y = doc.y + 4;
  const img = org.signatureImage || "";
  if (/^data:image\/(png|jpe?g);base64,/.test(img)) {
    try {
      doc.image(Buffer.from(img.replace(/^data:.*?;base64,/, ""), "base64"), x + W - 150, y, { fit: [150, 50], align: "right", valign: "center" });
    } catch {
      /* unreadable image: leave the space for a hand signature */
    }
  }
  y += compact ? 40 : 54;
  doc.moveTo(x + W - 150, y).lineTo(x + W, y).lineWidth(0.5).strokeColor("#9ca3af").stroke();
  doc.font("r").fontSize(8.5).fillColor("#374151").text(org.signatoryLabel || "Authorised Signatory", x, y + 4, { width: W, align: "right" });
  doc.y = y + 18;
}

// A5: terms on the left beside the signatory (as on many Indian invoices), in smaller type if needed, so the
// whole invoice stays on one page. False when even that doesn't fit (the caller then prints them below).
function signatoryBesideTerms(doc, org, terms) {
  const L = doc.page.margins.left;
  const W = doc.page.width - 2 * L;
  const tw = W - 215;
  const top = doc.y;
  const room = doc.page.height - doc.page.margins.bottom - 4 - top;
  if (room < 74 || tw < 100) return false;
  const hOf = (f) => (doc.font("r").fontSize(f), doc.heightOfString(terms, { width: tw }) + Math.min(8, f) + 10);
  let fs = 7.5;
  while (fs > 5.5 && hOf(fs) > room) fs -= 0.25;
  if (hOf(fs) > room) return false;
  doc.font("r").fontSize(Math.min(8, fs + 0.5)).fillColor(MUTED).text("Terms & Conditions", L, top + 6, { width: tw, lineBreak: false });
  doc.font("r").fontSize(fs).fillColor("#374151").text(terms, L, top + 6 + Math.min(8, fs + 0.5) + 3, { width: tw });
  const end = doc.y;
  doc.y = top;
  signatory(doc, org);
  doc.y = Math.max(end, doc.y);
  return true;
}

function pageNumbers(doc, org) {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    const m = doc.page.margins.bottom;
    doc.page.margins.bottom = 0; // writing in the margin must not start a new page
    doc.font("r").fontSize(7.5).fillColor(MUTED).text(`${org.name} · Page ${i + 1} of ${range.count}`, doc.page.margins.left, doc.page.height - (doc.page.margins.left < 40 ? 18 : 30), { width: doc.page.width - 2 * doc.page.margins.left, align: "center", lineBreak: false });
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
  const L = doc.page.margins.left;
  const W = doc.page.width - 2 * doc.page.margins.left;
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
  const doc = setup(meta.paper === "A5" ? "A5" : "A4");
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
  // Terms: the document's own, else the company's default terms (Settings) — like Tally, which prints them at print time.
  // Amount in words and notes, then the authorised signatory, and the terms & conditions last (as in Tally).
  footerNotes(doc, d.total, d.customerNotes, "", d.currency, d.exchangeRate);
  const terms = d.terms || meta.defaultTerms || "";
  if (meta.paper === "A5" && terms && !meta.noSignatory && signatoryBesideTerms(doc, org, terms)) {
    /* both drawn, side by side */
  } else {
    if (!meta.noSignatory) signatory(doc, org);
    footerNotes(doc, null, "", terms, d.currency, d.exchangeRate);
  }
  pageNumbers(doc, org);
  return toBuffer(doc);
}

async function receiptPdf(org, p, { title, partyLabel, party, appliedLabel, applied }) {
  const doc = setup();
  header(doc, org, title, p.paymentNumber);
  const L = doc.page.margins.left;
  const W = doc.page.width - 2 * doc.page.margins.left;
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
  doc.y += 10;
  signatory(doc, org);
  pageNumbers(doc, org);
  return toBuffer(doc);
}

/**
 * Roll-paper (direct thermal / receipt printer) layout, 2" (58 mm) or 3" (80 mm) wide, one long page: company,
 * document, customer, items (name, then qty x rate = amount), tax, total, amount in words, signatory, terms.
 * Drawn twice: once to measure the length, once on a page of exactly that length.
 */
async function thermalPdf(org, d, meta, widthIn = 3) {
  const PW = Math.round(Math.min(3, Math.max(2, widthIn)) * 72);
  const draw = (doc) => {
    const M = 8;
    const W = PW - 2 * M;
    const small = PW < 180;
    const fs = small ? 6.8 : 7.6;
    let y = 8;
    const t = (s, o = {}) => {
      if (!s && s !== 0) return;
      doc.font("b").fontSize(o.size || fs).fillColor("#000").text(String(s), M + (o.x || 0), y, { width: (o.w || W) - (o.x || 0), align: o.align || "left" });
      y = doc.y + (o.gap ?? 1);
    };
    const lr = (l, r, o = {}) => {
      doc.font("b").fontSize(o.size || fs).fillColor("#000"); // thermal heads print thin strokes faintly: all bold
      const rw = doc.widthOfString(String(r)) + 2;
      const top = y;
      doc.text(String(l), M, top, { width: W - rw - 4 });
      const yl = doc.y;
      doc.text(String(r), M, top, { width: W, align: "right" });
      y = Math.max(yl, doc.y) + (o.gap ?? 1);
    };
    const rule = (dash) => {
      y += 2;
      doc.moveTo(M, y).lineTo(PW - M, y).lineWidth(0.9).strokeColor("#000");
      if (dash) doc.dash(2, { space: 2 });
      doc.stroke().undash();
      y += 4;
    };
    t(org.name, { b: true, size: fs + 3, align: "center" });
    t(addrLines(org.address).join(", "), { align: "center" });
    t([org.phone ? `Ph: ${org.phone}` : "", org.email].filter(Boolean).join("  "), { align: "center" });
    if (org.gstin) t(`GSTIN: ${org.gstin}`, { b: true, align: "center" });
    rule();
    t(meta.title, { b: true, size: fs + 1.5, align: "center", gap: 2 });
    lr(`No: ${meta.number || ""}`, (meta.facts.find(([k]) => /date/i.test(k)) || [, ""])[1]);
    for (const [k, v] of meta.facts.filter(([k, v]) => v && !/date/i.test(k) && !/^Terms$/.test(k))) lr(/[:#]$/.test(k) ? k : `${k}:`, v);
    rule(true);
    const party = d.vendorName ? "vendor" : "customer";
    t(`${meta.partyLabel}: ${d[`${party}Name`] || ""}`, { b: true });
    const a = d.billingAddress || {};
    t([a.street, a.city, a.pincode].filter(Boolean).join(", "));
    if (d[`${party}Gstin`]) t(`GSTIN: ${d[`${party}Gstin`]}`);
    if (d.placeOfSupply) t(`Place of supply: ${stateName(d.placeOfSupply)} (${d.placeOfSupply})`);
    rule();
    lr("Item", "Amount", { b: true });
    rule(true);
    (d.lineItems || []).forEach((l, i) => {
      t(`${i + 1}. ${l.name}`, { b: true, gap: 0 });
      if (l.sku && !String(l.description || "").includes(l.sku)) t(`  SKU: ${l.sku}`, { size: fs - 0.6, gap: 0 });
      const extra = [l.hsnSac ? `HSN ${l.hsnSac}` : "", l.taxRate ? `GST ${l.taxRate}%` : "", l.discount ? `Disc ${l.discount}` : ""].filter(Boolean).join(" · ");
      lr(`  ${l.quantity}${l.unit ? " " + l.unit : ""} x ${num(l.rate)}${extra && !small ? `  ${extra}` : ""}`, num(l.amount), { gap: small && extra ? 0 : 2 });
      if (small && extra) t(`  ${extra}`, { size: fs - 0.8, gap: 2 });
    });
    rule();
    lr("Sub Total", num(d.subTotal));
    if (d.isInterState) lr("IGST", num(d.igst));
    else {
      lr("CGST", num(d.cgst));
      lr("SGST", num(d.sgst));
    }
    if (d.shippingCharge) lr("Shipping", num(d.shippingCharge));
    if (d.adjustment) lr("Adjustment / Round off", num(d.adjustment));
    rule(true);
    lr("TOTAL", money(d.total, d.currency), { b: true, size: fs + 2.5, gap: 2 });
    if (meta.paid) lr("Paid / Credits", `(-) ${num(meta.paid)}`);
    if (meta.balance !== undefined && meta.balance !== d.total) lr(meta.balanceLabel || "Balance Due", money(meta.balance, d.currency), { b: true });
    t(inWords(d.total), { size: fs - 0.6, gap: 3 });
    if (d.customerNotes) t(d.customerNotes, { size: fs - 0.4, gap: 3 });
    if (!meta.noSignatory) {
      rule(true);
      t(`For ${org.name}`, { b: true, align: "right", gap: 2 });
      const img = org.signatureImage || "";
      let room = 24; // space to sign by hand
      if (/^data:image\/(png|jpe?g);base64,/.test(img)) {
        try {
          doc.image(Buffer.from(img.replace(/^data:.*?;base64,/, ""), "base64"), PW - M - 110, y, { fit: [110, 36], align: "right" });
          room = 38;
        } catch {
          /* unreadable image */
        }
      }
      y += room;
      t(org.signatoryLabel || "Authorised Signatory", { align: "right", gap: 3 });
    }
    const terms = d.terms || meta.defaultTerms || "";
    if (terms) {
      rule(true);
      t("Terms & Conditions", { b: true, size: fs - 0.4 });
      t(terms, { size: fs - 0.8, gap: 3 });
    }
    rule(true);
    t("Thank you!", { align: "center", size: fs, gap: 0 });
    return y + 10;
  };
  const mk = (h) => {
    const doc = new PDFDocument({ size: [PW, h], margin: 0 });
    doc.registerFont("r", FONT);
    doc.registerFont("b", BOLD);
    return doc;
  };
  const probe = mk(14400);
  const h = Math.ceil(draw(probe));
  probe.end();
  const doc = mk(Math.max(h, 144));
  draw(doc);
  return toBuffer(doc);
}

/**
 * The same roll layout as HTML, for printing from the browser: the page is sized to the roll (2"/3" wide, exactly as
 * long as the content), so the printer driver prints it at full size instead of shrinking a PDF to its paper.
 */
function thermalHtml(org, d, meta, widthIn = 3) {
  const w = Math.min(3, Math.max(2, Number(widthIn) || 3));
  const small = w < 2.5;
  const e = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const row = (l, r, cls = "") => `<div class="lr ${cls}"><span>${e(l)}</span><span>${e(r)}</span></div>`;
  const party = d.vendorName ? "vendor" : "customer";
  const a = d.billingAddress || {};
  const date = (meta.facts.find(([k]) => /date/i.test(k)) || [, ""])[1];
  const facts = meta.facts.filter(([k, v]) => v && !/date/i.test(k) && !/^Terms$/.test(k));
  const items = (d.lineItems || [])
    .map((l, i) => {
      const extra = [l.hsnSac ? `HSN ${l.hsnSac}` : "", l.taxRate ? `GST ${l.taxRate}%` : "", l.discount ? `Disc ${l.discount}` : ""].filter(Boolean).join(" · ");
      return `<div class="it"><div class="b">${i + 1}. ${e(l.name)}</div>${row(`${l.quantity}${l.unit ? " " + l.unit : ""} × ${num(l.rate)}`, num(l.amount))}${extra ? `<div class="sm">${e(extra)}</div>` : ""}</div>`;
    })
    .join("");
  const img = /^data:image\/(png|jpe?g);base64,/.test(org.signatureImage || "") ? `<img class="sig" src="${org.signatureImage}" alt="">` : `<div class="signspace"></div>`;
  const terms = d.terms || meta.defaultTerms || "";
  const tax = d.isInterState ? row("IGST", num(d.igst)) : row("CGST", num(d.cgst)) + row("SGST", num(d.sgst));
  return `<!doctype html><html><head><meta charset="utf-8"><title>${e(meta.title)} ${e(meta.number)}</title><style>
@page { size: ${w}in 200mm; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; color: #000; }
body { width: ${w}in; padding: 2mm ${small ? 1.5 : 2.5}mm 4mm; font-family: Arial, "Helvetica Neue", Helvetica, sans-serif; font-size: ${small ? 9 : 11}pt; line-height: 1.25; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.c { text-align: center; } .r { text-align: right; } .b { font-weight: 700; }
.h1 { font-size: ${small ? 12.5 : 15}pt; font-weight: 800; }
.h2 { font-size: ${small ? 10.5 : 12.5}pt; font-weight: 800; margin: 1mm 0; }
.sm { font-size: ${small ? 7.5 : 9}pt; }
.lr { display: flex; justify-content: space-between; gap: 2mm; } .lr span:last-child { text-align: right; white-space: nowrap; }
.tot { font-size: ${small ? 12 : 14.5}pt; font-weight: 800; margin: 1mm 0; }
hr { border: 0; border-top: 1px solid #000; margin: 1.5mm 0; } hr.d { border-top-style: dashed; }
.it { margin: 0 0 1.2mm; }
.sig { display: block; margin-left: auto; max-width: 45mm; max-height: 15mm; } .signspace { height: 10mm; }
.pre { white-space: pre-wrap; }
</style></head><body>
<div class="c h1">${e(org.name)}</div>
<div class="c sm">${e(addrLines(org.address).join(", "))}</div>
<div class="c sm">${e([org.phone ? `Ph: ${org.phone}` : "", org.email].filter(Boolean).join("  "))}</div>
${org.gstin ? `<div class="c b">GSTIN: ${e(org.gstin)}</div>` : ""}
<hr><div class="c h2">${e(meta.title)}</div>
${row(`No: ${meta.number || ""}`, date)}
${facts.map(([k, v]) => row(/[:#]$/.test(k) ? k : `${k}:`, v)).join("")}
<hr class="d"><div class="b">${e(meta.partyLabel)}: ${e(d[`${party}Name`] || "")}</div>
${[a.street, a.city, a.pincode].filter(Boolean).length ? `<div class="sm">${e([a.street, a.city, a.pincode].filter(Boolean).join(", "))}</div>` : ""}
${d[`${party}Gstin`] ? `<div class="sm">GSTIN: ${e(d[`${party}Gstin`])}</div>` : ""}
${d.placeOfSupply ? `<div class="sm">Place of supply: ${e(stateName(d.placeOfSupply))} (${e(d.placeOfSupply)})</div>` : ""}
<hr>${row("Item", "Amount", "b")}<hr class="d">${items}<hr>
${row("Sub Total", num(d.subTotal))}${tax}
${d.shippingCharge ? row("Shipping", num(d.shippingCharge)) : ""}${d.adjustment ? row("Adjustment / Round off", num(d.adjustment)) : ""}
<hr class="d">${row("TOTAL", money(d.total, d.currency), "tot")}
${meta.paid ? row("Paid / Credits", `(-) ${num(meta.paid)}`) : ""}
${meta.balance !== undefined && meta.balance !== d.total ? row(meta.balanceLabel || "Balance Due", money(meta.balance, d.currency), "b") : ""}
<div class="sm">${e(inWords(d.total))}</div>
${d.customerNotes ? `<div class="sm pre" style="margin-top:1mm">${e(d.customerNotes)}</div>` : ""}
${meta.noSignatory ? "" : `<hr class="d"><div class="r b">For ${e(org.name)}</div>${img}<div class="r">${e(org.signatoryLabel || "Authorised Signatory")}</div>`}
${terms ? `<hr class="d"><div class="b sm">Terms &amp; Conditions</div><div class="sm pre">${e(terms)}</div>` : ""}
<hr class="d"><div class="c">Thank you!</div>
</body></html>`;
}

module.exports = { thermalHtml, thermalPdf, documentPdf, receiptPdf, inWords, money, fmtDate };
