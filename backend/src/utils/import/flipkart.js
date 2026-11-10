/**
 * Flipkart sales import (Seller Hub → Reports → Tax reports):
 *   Sales Report workbook ("Sales Report" + "Cash Back Report" sheets), one month.
 *   Sale rows → one invoice per Buyer Invoice ID; Return / Cancellation rows (negative values) → one credit note per
 *   document ID; Return Cancellation rows (positive) → an invoice with Flipkart's document ID.
 *   Cash Back rows (bank-offer credit / debit notes, linked by order item): positive → invoice, negative → credit note.
 * Sales Report + Cash Back Report together = Flipkart's net taxable value in GSTR-8 (Section 3) and GSTR-1.
 * The GSTR-1 workbook (Section 7(A)(2), 7(B)(2), 12, 13, GSTR-8 Section 3) is read for the check.
 * Documents come out in the same shape as the Amazon plan, so the same import job posts them.
 */
const { stateCode, snapRate, round2 } = require("./common");
const { readZip, isZip } = require("../zip");

const num = (v) => {
  const n = Number(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};
const clean = (v) => String(v ?? "").replace(/^"+|"+$/g, "").trim();
const na = (v) => {
  const s = clean(v);
  return /^(na|n\/a|null|-)$/i.test(s) ? "" : s;
};
const dateOf = (s) => {
  if (s instanceof Date) return new Date(Date.UTC(s.getFullYear(), s.getMonth(), s.getDate()));
  const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
};
const sign = (x) => (x < 0 ? -1 : 1);
const GSTIN_RX = /^\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;

// Flipkart's files declare a wrong sheet size (A1:A1): work it out from the cells actually there.
function fixRef(ws) {
  const XLSX = require("xlsx");
  let r = 0;
  let c = 0;
  for (const k of Object.keys(ws)) {
    if (k[0] === "!") continue;
    const a = XLSX.utils.decode_cell(k);
    if (a.r > r) r = a.r;
    if (a.c > c) c = a.c;
  }
  ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r, c } });
  return ws;
}

function sheetRows(wb, name) {
  const XLSX = require("xlsx");
  const ws = wb.Sheets[name] && fixRef(wb.Sheets[name]);
  if (!ws) return [];
  const all = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: false });
  const head = (all[0] || []).map((h) => String(h).replace(/\s+/g, " ").trim());
  return all.slice(1).filter((r) => r.some((x) => x !== "" && x !== null)).map((r) => Object.fromEntries(head.map((k, i) => [k, r[i]])));
}

// Files as uploaded ({ name, data }) → { sales: [rows], cashback: [rows], gstr1: [{ wb, name }], names, unknown }.
function unpack(files) {
  const XLSX = require("xlsx");
  const flat = [];
  for (const f of files) {
    if (isZip(f.data) && !/\.xlsx$/i.test(f.name)) flat.push(...readZip(f.data));
    else flat.push(f);
  }
  const out = { sales: [], cashback: [], gstr1: [], names: [], unknown: [] };
  for (const f of flat) {
    let wb;
    try {
      wb = XLSX.read(f.data, { type: "buffer", cellDates: false });
    } catch {
      out.unknown.push(f.name);
      continue;
    }
    if (wb.SheetNames.includes("Sales Report")) {
      const s = sheetRows(wb, "Sales Report");
      const c = sheetRows(wb, "Cash Back Report");
      if (s.length && "Buyer Invoice ID" in s[0]) {
        out.sales.push(...s);
        out.cashback.push(...c);
        out.names.push(`${f.name} (Flipkart Sales Report, ${s.length} rows + ${c.length} cash back)`);
        continue;
      }
    }
    if (wb.SheetNames.some((n) => /Section 7\(B\)\(2\) in GSTR-1/i.test(n))) {
      out.gstr1.push({ wb, name: f.name });
      out.names.push(`${f.name} (Flipkart GSTR-1 report)`);
      continue;
    }
    out.unknown.push(f.name);
  }
  return out;
}

const rateOf = (r) => snapRate(num(r["IGST Rate"]) || num(r["CGST Rate"]) + num(r["SGST Rate (or UTGST as applicable)"]));
const taxOf = (r) => ({ igst: num(r["IGST Amount"]), cgst: num(r["CGST Amount"]), sgst: num(r["SGST Amount (Or UTGST as applicable)"]) });

function plan(sales, cashback, orgGstin) {
  const docs = new Map();
  const skipped = { cancel: 0, freeReplacement: 0, other: 0, otherGstin: {}, unknown: {} };
  const byItem = new Map(); // order item → { hsn, sku, name } (cash back rows carry no product)
  const take = (r, kind) => {
    const gstin = clean(r["Seller GSTIN"]).toUpperCase();
    if (orgGstin && gstin && gstin !== orgGstin) {
      skipped.otherGstin[gstin] = (skipped.otherGstin[gstin] || 0) + 1;
      return null;
    }
    return gstin;
  };
  const docOf = (number, kind, r, date) => {
    const key = `${kind}|${number}`;
    if (!docs.has(key)) {
      const buyerGstin = na(r["Business GST Number"]).toUpperCase();
      const b2b = GSTIN_RX.test(buyerGstin);
      const ship = stateCode(clean(r["Customer's Delivery State"]));
      docs.set(key, {
        kind,
        number,
        date,
        invoiceNumber: "",
        b2b,
        buyerGstin: b2b ? buyerGstin : "",
        buyerName: b2b ? na(r["Business Name"]) : "",
        billTo: { city: "", state: stateCode(clean(r["Customer's Billing State"])) || ship, pincode: na(r["Customer's Billing Pincode"]) },
        shipTo: { city: "", state: ship, pincode: na(r["Customer's Delivery Pincode"]) },
        orders: new Set(),
        channel: "",
        payment: "",
        irn: na(r.IRN),
        irnDate: "",
        tcs: 0,
        tds: 0,
        shopsy: false,
        events: new Set(),
        lines: [],
        amazon: { value: 0, igst: 0, cgst: 0, sgst: 0 },
      });
    }
    return docs.get(key);
  };

  for (const r of sales) {
    if (take(r) === null) continue;
    const number = clean(r["Buyer Invoice ID"]);
    const taxable = num(r["Taxable Value (Final Invoice Amount -Taxes)"]);
    const sub = clean(r["Event Sub Type"]);
    if (!number || (!taxable && !num(r["Final Invoice Amount (Price after discount+Shipping Charges)"]))) {
      skipped.other++;
      continue;
    }
    const kind = taxable < 0 ? "creditNote" : "invoice";
    const d = docOf(number, kind, r, dateOf(r["Buyer Invoice Date"]) || dateOf(r["Order Date"]));
    const s = sign(taxable);
    const sku = clean(r.SKU).replace(/^SKU:/i, "").trim();
    const name = clean(r["Product Title/Description"]).replace(/\s+/g, " ") || sku || "Flipkart item";
    const hsn = na(r["HSN Code"]);
    const item = clean(r["Order Item ID"]);
    byItem.set(item, { hsn, sku, name });
    d.lines.push({ kind: "product", name, sku, hsn, rate: rateOf(r), quantity: Math.abs(num(r["Item Quantity"])) || 1, taxable: round2(taxable), orderId: clean(r["Order ID"]), fsn: clean(r.FSN) });
    d.orders.add(clean(r["Order ID"]));
    d.events.add(sub);
    const t = taxOf(r);
    d.amazon.value = round2(d.amazon.value + s * Math.abs(num(r["Final Invoice Amount (Price after discount+Shipping Charges)"])));
    d.amazon.igst = round2(d.amazon.igst + t.igst);
    d.amazon.cgst = round2(d.amazon.cgst + t.cgst);
    d.amazon.sgst = round2(d.amazon.sgst + t.sgst);
    d.tcs = round2(d.tcs + num(r["Total TCS Deducted"]));
    d.tds = round2(d.tds + num(r["TDS Amount"]));
    if (/true/i.test(clean(r["Is Shopsy Order?"]))) d.shopsy = true;
    d.payment = clean(r["Order Type"]);
    d.channel = clean(r["Fulfilment Type"]);
  }

  // Bank-offer cash back: Flipkart's credit note (positive) adds to the sale, its debit note (negative) reduces it.
  for (const r of cashback) {
    if (take(r) === null) continue;
    const number = clean(r["Credit Note ID/ Debit Note ID"]);
    const value = num(r["Invoice Amount"]);
    const taxable = num(r["Taxable Value"]) * (value < 0 && num(r["Taxable Value"]) > 0 ? -1 : 1);
    if (!number || !taxable) {
      skipped.other++;
      continue;
    }
    const kind = taxable < 0 ? "creditNote" : "invoice";
    const d = docOf(number, kind, r, dateOf(r["Invoice Date"]));
    const item = clean(r["Order Item ID"]);
    const p = byItem.get(item) || {};
    d.lines.push({ kind: "cashback", name: `Bank offer ${clean(r["Document Type"]).toLowerCase()}${p.name ? ` — ${p.name}` : ""}`.slice(0, 250), sku: "", hsn: p.hsn || "", rate: rateOf(r), quantity: 1, taxable: round2(taxable), orderId: clean(r["Order ID"]) });
    d.orders.add(clean(r["Order ID"]));
    d.events.add(`Cash back ${clean(r["Document Type"])}`);
    const t = taxOf(r);
    d.amazon.value = round2(d.amazon.value + sign(taxable) * Math.abs(value));
    d.amazon.igst = round2(d.amazon.igst + t.igst * (sign(t.igst) === sign(taxable) || !t.igst ? 1 : -1));
    d.amazon.cgst = round2(d.amazon.cgst + t.cgst * (sign(t.cgst) === sign(taxable) || !t.cgst ? 1 : -1));
    d.amazon.sgst = round2(d.amazon.sgst + t.sgst * (sign(t.sgst) === sign(taxable) || !t.sgst ? 1 : -1));
    d.tcs = round2(d.tcs + num(r["Total TCS Deducted"]));
    d.tds = round2(d.tds + num(r["TDS Amount"]));
  }

  const fin = (d) => {
    d.orders = [...d.orders].filter(Boolean);
    d.events = [...d.events].filter(Boolean);
    d.pos = d.shipTo.state || d.billTo.state || (d.buyerGstin ? d.buyerGstin.slice(0, 2) : "");
    d.taxable = round2(d.lines.reduce((t, l) => t + l.taxable, 0));
    d.amazon.tax = round2(d.amazon.igst + d.amazon.cgst + d.amazon.sgst);
    return d;
  };
  const all = [...docs.values()].map(fin);
  return { invoices: all.filter((d) => d.kind === "invoice"), creditNotes: all.filter((d) => d.kind === "creditNote"), skipped };
}

/* ---------------- Flipkart's GSTR-1 report (for the check) ---------------- */
function readGstr1(wb) {
  const XLSX = require("xlsx");
  const rows = (name) => {
    const n = wb.SheetNames.find((x) => x.startsWith(name));
    if (!n) return [];
    const all = XLSX.utils.sheet_to_json(fixRef(wb.Sheets[n]), { header: 1, defval: "", raw: false });
    const head = (all[0] || []).map((h) => String(h).replace(/\s+/g, " ").trim());
    return all.slice(1).filter((r) => r.some((x) => x !== "")).map((r) => Object.fromEntries(head.map((k, i) => [k, r[i]])));
  };
  return {
    b2csLocal: rows("Section 7(A)(2)").map((r) => ({ pos: "", rate: snapRate(num(r["CGST %"]) * 2), taxable: num(r["Aggregate Taxable Value Rs."]), tax: num(r["CGST Amount Rs."]) + num(r["SGST /UT Amount Rs."]) })),
    b2csOut: rows("Section 7(B)(2)").map((r) => ({ pos: stateCode(clean(r["Delivered State (PoS)"])), rate: snapRate(num(r["IGST %"])), taxable: num(r["Aggregate Taxable Value Rs."]), tax: num(r["IGST Amount Rs."]) })),
    b2cl: rows("Section 5B").map((r) => ({ number: clean(r["Invoice Number"]), pos: stateCode(clean(r["Delivered State (PoS)"])), rate: snapRate(num(r["IGST %"])), taxable: num(r["Taxable Value Rs."]) })),
    hsn: rows("Section 12").map((r) => ({ hsn: clean(r["HSN Number"]), qty: num(r["Total Quantity in Nos."]), taxable: num(r["Total Taxable Value Rs."]), igst: num(r["IGST Amount Rs."]), cgst: num(r["CGST Amount Rs."]), sgst: num(r["SGST Amount Rs."]) })),
    docs: rows("Section 13").map((r) => ({ from: clean(r["Invoice Series From"]), to: clean(r["Invoice Series To"]), total: num(r["Total Number of Invoices"]), cancelled: num(r["Cancelled if any"]) })),
    tcs: rows("Section 3").map((r) => ({ net: num(r["Net Taxable Value"]), igst: num(r["IGST Amount Rs."]), cgst: num(r["CGST Amount Rs."]), sgst: num(r["SGST Amount Rs."]), tcs: num(r["TCS IGST amount Rs."]) + num(r["TCS CGST amount Rs."]) + num(r["TCS SGST amount Rs."]) }))[0] || null,
  };
}

module.exports = { unpack, plan, readGstr1 };
