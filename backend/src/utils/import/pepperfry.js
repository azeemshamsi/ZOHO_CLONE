/**
 * Pepperfry sales import (Pepperfry seller panel → Reports):
 *   GSTR-1 report zip: "GSTR-1_<merchant>_<state>…csv" (one row per order item invoiced in the month) and
 *   "GSTR-1_Refunds_…csv" (one row per order item returned in the month).
 *   TCS report zip: "tcs_report_data…csv" (sales and refund rows with TCS) and "summary_report…csv" (the month's
 *   gross / returns / net and TCS, as in Pepperfry's GSTR-8) — used for TCS and the check.
 * Invoice number = Pepperfry's order number (as in Pepperfry's GSTR-1); returns carry no credit note number, so the
 * credit note is "PFCN<order number>" (a second return of the same order gets "-2"), dated on the return date.
 * Documents come out in the same shape as the Amazon plan, so the same import job posts them.
 */
const { stateCode, snapRate, round2 } = require("./common");
const { readZip, isZip } = require("../zip");

const num = (v) => {
  const n = Number(String(v ?? "").replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : 0;
};
const GSTIN_RX = /^\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;
// "06/10/2026" or "2026-10-01 11:55:47" → UTC date.
const dateOf = (s) => {
  const t = String(s || "").trim();
  let m = t.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
};

// CSV → arrays (Pepperfry's GSTR-1 files repeat column names, so rows stay positional).
function csvRows(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let q = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((x) => String(x).trim() !== ""));
}
// Header → reader: get("Taxable Value") is the first column of that name, get("Taxable Value", 2) the second.
function table(rows) {
  const head = (rows[0] || []).map((h) => String(h).replace(/\s+/g, " ").trim());
  const at = (name, n = 1) => {
    let seen = 0;
    for (let i = 0; i < head.length; i++) if (head[i] === name && ++seen === n) return i;
    return -1;
  };
  return {
    head,
    rows: rows.slice(1).map((r) => {
      const get = (name, n) => {
        const i = at(name, n);
        return i < 0 ? "" : String(r[i] ?? "").trim();
      };
      return get;
    }),
  };
}

function unpack(files) {
  const flat = [];
  for (const f of files) {
    if (isZip(f.data)) flat.push(...readZip(f.data));
    else flat.push(f);
  }
  const out = { sales: null, refunds: null, tcs: null, summary: null, names: [], unknown: [] };
  for (const f of flat) {
    if (!/\.csv$/i.test(f.name)) {
      out.unknown.push(f.name);
      continue;
    }
    const t = table(csvRows(f.data.toString("utf8")));
    const h = t.head;
    if (h[0] === "OrderID-SKU" && h.includes("Invoice Number")) {
      out.sales = t;
      out.names.push(`${f.name} (Pepperfry GSTR-1, ${t.rows.length} items)`);
    } else if (h[0] === "Return Date" && h.includes("OrderID-SKU")) {
      out.refunds = t;
      out.names.push(`${f.name} (Pepperfry GSTR-1 refunds, ${t.rows.length} items)`);
    } else if (h[0] === "Type" && h.includes("Order-SKU") && h.includes("TCS")) {
      out.tcs = t;
      out.names.push(`${f.name} (Pepperfry TCS report, ${t.rows.length} rows)`);
    } else if (h[0] === "GSTIN of Supplier *" || h.some((x) => /^Net amount liable for TCS/.test(x))) {
      out.summary = t;
      out.names.push(`${f.name} (Pepperfry TCS summary)`);
    } else out.unknown.push(f.name);
  }
  return out;
}

function plan(u, orgGstin) {
  const skipped = { cancel: 0, freeReplacement: 0, other: 0, otherGstin: {}, unknown: {} };
  const tcsOf = new Map();
  for (const g of u.tcs?.rows || []) tcsOf.set(`${g("Type") === "Refund" ? "R" : "S"}|${g("Order-SKU")}`, num(g("TCS")));
  const docs = new Map();
  const add = (g, kind) => {
    const gstin = g("GSTIN").toUpperCase();
    if (orgGstin && gstin && gstin !== orgGstin) {
      skipped.otherGstin[gstin] = (skipped.otherGstin[gstin] || 0) + 1;
      return;
    }
    const inv = g("Invoice Number");
    const item = g("OrderID-SKU");
    if (!inv || !item) {
      skipped.other++;
      return;
    }
    const sale = kind === "invoice";
    const date = sale ? dateOf(g("Invoice Date")) : dateOf(g("Return Date")) || dateOf(g("Credit Note Date"));
    const cnNo = g("Credit Note No");
    const number = sale ? inv : cnNo || `PFCN${inv}`;
    const key = sale ? `i|${number}` : `c|${number}|${date ? date.toISOString().slice(0, 10) : ""}`;
    if (!docs.has(key)) {
      const buyer = g("GSTIN of Recipient").toUpperCase();
      const b2b = GSTIN_RX.test(buyer);
      const ship = stateCode(g("Ship to (State)")) || stateCode(g("Recipient State"));
      docs.set(key, {
        kind,
        number,
        date,
        invoiceNumber: sale ? "" : inv,
        invoiceDate: dateOf(g("Invoice Date")),
        b2b,
        buyerGstin: b2b ? buyer : "",
        buyerName: g("Name of the Recipient"),
        billTo: { city: "", state: stateCode(g("Recipient State"), b2b ? buyer : "") || ship, pincode: "" },
        shipTo: { city: "", state: ship, pincode: "" },
        orders: new Set(),
        channel: "",
        payment: "",
        irn: g("IRN"),
        irnDate: g("IRN Date"),
        tcs: 0,
        lines: [],
        amazon: { value: 0, igst: 0, cgst: 0, sgst: 0 },
      });
    }
    const d = docs.get(key);
    const s = sale ? 1 : -1;
    // Refund rows repeat the sale's figures: a part return takes its share (return qty / invoiced qty).
    const invQty = num(g(sale ? "Invoiced Quantity" : "Invoiced Qty")) || 1;
    const qty = sale ? invQty : num(g("Return Qty")) || invQty;
    const share = sale ? 1 : Math.min(1, qty / invQty);
    const taxable = round2(num(g("Taxable Value")) * share);
    const tax = { igst: round2(num(g("IGST Amount")) * share), cgst: round2(num(g("CGST Amount")) * share), sgst: round2(num(g("SGST/UTGST Amount")) * share) };
    d.lines.push({ kind: "product", name: (g("Product/Service Description") || g("Item Code") || "Pepperfry item").replace(/\s+/g, " "), sku: g("Item Code") || item.split("-").slice(1).join("-"), hsn: g("HSN/SAC"), rate: snapRate(num(g("Total GST Rate"))), quantity: qty, taxable: s * taxable, orderId: inv });
    d.orders.add(inv);
    d.amazon.value = round2(d.amazon.value + s * (taxable + tax.igst + tax.cgst + tax.sgst));
    d.amazon.igst = round2(d.amazon.igst + s * tax.igst);
    d.amazon.cgst = round2(d.amazon.cgst + s * tax.cgst);
    d.amazon.sgst = round2(d.amazon.sgst + s * tax.sgst);
    d.tcs = round2(d.tcs + (tcsOf.get(`${sale ? "S" : "R"}|${item}`) ?? s * num(g("TCS Amount"))));
  };
  for (const g of u.sales?.rows || []) add(g, "invoice");
  for (const g of u.refunds?.rows || []) add(g, "creditNote");
  // A second return of the same order on another day gets its own number.
  const seen = new Map();
  for (const d of [...docs.values()].filter((x) => x.kind === "creditNote").sort((a, b) => a.date - b.date)) {
    const n = (seen.get(d.number) || 0) + 1;
    seen.set(d.number, n);
    if (n > 1) d.number = `${d.number}-${n}`;
  }
  const fin = (d) => {
    d.orders = [...d.orders].filter(Boolean);
    d.pos = d.shipTo.state || d.billTo.state || (d.buyerGstin ? d.buyerGstin.slice(0, 2) : "");
    d.taxable = round2(d.lines.reduce((t, l) => t + l.taxable, 0));
    d.amazon.tax = round2(d.amazon.igst + d.amazon.cgst + d.amazon.sgst);
    return d;
  };
  const all = [...docs.values()].map(fin);
  return { invoices: all.filter((d) => d.kind === "invoice"), creditNotes: all.filter((d) => d.kind === "creditNote"), skipped };
}

// Pepperfry's TCS summary (GSTR-8 figures for the month).
function summaryOf(u) {
  const g = u.summary?.rows?.[0];
  if (!g) return null;
  const col = (rx) => num(g(u.summary.head.find((h) => rx.test(h)) || ""));
  return {
    gstin: g("GSTIN of Supplier *"),
    b2b: col(/^Gross value of supplies made to registered/i),
    b2bReturns: col(/^Value of supplies returned by registered/i),
    b2c: col(/^Gross value of supplies made to unregistered/i),
    b2cReturns: col(/^Value of supplies returned by unregistered/i),
    net: col(/^Net amount liable for TCS/i),
    tcs: col(/^Integrated Tax/i) + col(/^Central Tax/i) + col(/^State\/UT Tax/i),
  };
}

module.exports = { unpack, plan, summaryOf };
