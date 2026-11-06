/**
 * Amazon sales import (Seller Central reports):
 *   MTR B2C / MTR B2B CSV (Reports → Tax Document Library → Merchant Tax Report), zipped or not.
 *   Shipment rows → one invoice per Amazon invoice number (B2C to "Amazon B2C", B2B to the buyer's GSTIN);
 *   Refund rows → one credit note per Amazon credit note number, linked to its invoice;
 *   Cancel (no value) and FreeReplacement (zero value) rows are skipped and counted; rows of another seller GSTIN
 *   (e.g. an FBA state registration) are skipped and counted.
 * Amounts are Amazon's tax-exclusive values (product + shipping + gift wrap, less promotions), so taxable values
 * match the MTR and Amazon's GSTR-1 exactly; a few paise of tax rounding go to the invoice adjustment so totals
 * match Amazon's invoice amount.
 * Amazon's GSTR-1 workbook (B2B, B2B CN, B2C Large, B2C Small, HSN) is read for the check (reconcile).
 */
const { stateCode, snapRate, round2 } = require("./common");
const { readZip, isZip } = require("../zip");

const num = (v) => Number(String(v ?? "").replace(/,/g, "")) || 0;
const dateOf = (s) => {
  const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
};
const iso = (d) => (d ? d.toISOString().slice(0, 10) : "");

/* ---------------- files ---------------- */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
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
  const head = (rows.shift() || []).map((h) => h.replace(/^﻿/, "").trim());
  return rows.filter((r) => r.some((x) => x !== "")).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? "").trim()])));
}

// Files as uploaded ({ name, data: Buffer }) → { mtr: [rows], gstr1: [{ gstin, wb }], unknown: [names] }.
function unpack(files) {
  const flat = [];
  for (const f of files) {
    if (isZip(f.data) && !/\.xlsx$/i.test(f.name)) flat.push(...readZip(f.data));
    else flat.push(f);
  }
  const out = { mtr: [], gstr1: [], unknown: [], names: [] };
  for (const f of flat) {
    if (/\.csv$/i.test(f.name) || (!/\.xlsx?$/i.test(f.name) && !isZip(f.data))) {
      const rows = parseCsv(f.data.toString("utf8"));
      if (rows.length && "Transaction Type" in rows[0] && "Invoice Number" in rows[0] && "Seller Gstin" in rows[0]) {
        const b2b = "Customer Bill To Gstid" in rows[0];
        for (const r of rows) r._report = b2b ? "b2b" : "b2c";
        out.mtr.push(...rows);
        out.names.push(`${f.name} (${b2b ? "MTR B2B" : "MTR B2C"}, ${rows.length} rows)`);
      } else out.unknown.push(f.name);
    } else {
      const XLSX = require("xlsx");
      const wb = XLSX.read(f.data, { type: "buffer" });
      if (wb.SheetNames.includes("B2C Small") && wb.SheetNames.includes("B2B")) {
        const g = XLSX.utils.sheet_to_json(wb.Sheets.GSTIN || wb.Sheets[wb.SheetNames[0]], { header: 1 }).flat().find((x) => /^\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/.test(String(x || "").trim()));
        out.gstr1.push({ gstin: String(g || (f.name.match(/\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]/) || [""])[0]).trim(), wb, name: f.name });
        out.names.push(`${f.name} (Amazon GSTR-1, ${g || "?"})`);
      } else out.unknown.push(f.name);
    }
  }
  return out;
}

/* ---------------- MTR → documents ---------------- */
// GST rate on a row (Amazon gives 0.05 etc.).
const rateOf = (r) => snapRate((num(r["Cgst Rate"]) + num(r["Sgst Rate"]) + num(r["Utgst Rate"]) + num(r["Igst Rate"])) * 100);

function linesOf(r, sign) {
  const q = Math.abs(num(r.Quantity)) || 1;
  const rate = rateOf(r);
  const product = sign * (num(r["Principal Amount Basis"]) + num(r["Item Promo Discount Basis"]));
  const shipping = sign * (num(r["Shipping Amount Basis"]) + num(r["Shipping Promo Discount Basis"]));
  const gift = sign * (num(r["Gift Wrap Amount Basis"]) + num(r["Gift Wrap Promo Discount Basis"]));
  const base = { hsn: String(r["Hsn/sac"] || "").trim(), sku: String(r.Sku || "").trim(), asin: r.Asin || "", rate, orderId: r["Order Id"] || "" };
  const lines = [];
  // A promotion bigger than the charge it's on folds into the product line.
  // (On refunds everything is negative: shipping / gift wrap refunded get their own lines too.)
  const neg = product < 0;
  const own = (v) => (neg ? v < 0 : v > 0);
  const extra = (own(shipping) ? 0 : shipping) + (own(gift) ? 0 : gift);
  lines.push({ ...base, kind: "product", name: String(r["Item Description"] || r.Sku || "Amazon item").replace(/\s+/g, " ").trim(), quantity: q, taxable: round2(product + extra) });
  if (own(shipping)) lines.push({ ...base, kind: "shipping", name: "Shipping charges", quantity: 1, taxable: round2(shipping) });
  if (own(gift)) lines.push({ ...base, kind: "giftwrap", name: "Gift wrap", quantity: 1, taxable: round2(gift) });
  // Amazon's tax by head on this row.
  const promoTax = num(r["Item Promo Tax"]) + num(r["Shipping Promo Tax"]) + num(r["Gift Wrap Promo Tax"]);
  const igst = num(r["Igst Tax"]) + num(r["Shipping Igst Tax"]) + num(r["Gift Wrap Igst Tax"]) + (num(r["Igst Rate"]) > 0 ? promoTax : 0);
  const half = num(r["Igst Rate"]) > 0 ? 0 : promoTax / 2;
  const cgst = num(r["Cgst Tax"]) + num(r["Shipping Cgst Tax"]) + num(r["Gift Wrap Cgst Tax"]) + half;
  const sgst = num(r["Sgst Tax"]) + num(r["Utgst Tax"]) + num(r["Shipping Sgst Tax"]) + num(r["Shipping Utgst Tax"]) + num(r["Gift Wrap Sgst Tax"]) + num(r["Gift Wrap Utgst Tax"]) + half;
  return { lines, tax: { igst: sign * igst, cgst: sign * cgst, sgst: sign * sgst }, value: sign * num(r["Invoice Amount"]) };
}

function plan(rows, orgGstin) {
  const invoices = new Map();
  const notes = new Map();
  const skipped = { cancel: 0, freeReplacement: 0, other: 0, otherGstin: {}, unknown: {} };
  for (const r of rows) {
    const gstin = String(r["Seller Gstin"] || "").trim().toUpperCase();
    if (orgGstin && gstin !== orgGstin) {
      skipped.otherGstin[gstin] = (skipped.otherGstin[gstin] || 0) + 1;
      continue;
    }
    const type = String(r["Transaction Type"] || "").trim();
    if (type === "Cancel") {
      skipped.cancel++;
      continue;
    }
    if (type === "FreeReplacement") {
      skipped.freeReplacement++;
      continue;
    }
    const isRefund = type === "Refund";
    if (type !== "Shipment" && !isRefund) {
      skipped.unknown[type] = (skipped.unknown[type] || 0) + 1;
      continue;
    }
    const number = String(isRefund ? r["Credit Note No"] : r["Invoice Number"]).trim();
    if (!number) {
      skipped.other++;
      continue;
    }
    const map = isRefund ? notes : invoices;
    const buyerGstin = String(r["Customer Bill To Gstid"] || "").trim().toUpperCase();
    if (!map.has(number)) {
      map.set(number, {
        kind: isRefund ? "creditNote" : "invoice",
        number,
        date: dateOf(isRefund ? r["Credit Note Date"] || r["Invoice Date"] : r["Invoice Date"]),
        invoiceNumber: isRefund ? String(r["Invoice Number"] || "").trim() : number,
        invoiceDate: dateOf(r["Invoice Date"]),
        report: r._report,
        b2b: !!buyerGstin,
        buyerGstin,
        buyerName: String(r["Buyer Name"] || "").trim(),
        billTo: { city: r["Bill To City"] || "", state: stateCode(r["Bill To State"] || "", buyerGstin), pincode: r["Bill To Postalcode"] || "" },
        shipTo: { city: r["Ship To City"] || "", state: stateCode(r["Ship To State"] || ""), pincode: r["Ship To Postal Code"] || "" },
        orders: new Set(),
        channel: r["Fulfillment Channel"] || "",
        payment: r["Payment Method Code"] || "",
        irn: r["Irn Number"] || "",
        irnDate: r["Irn Date"] || "",
        irnStatus: r["Irn Filing Status"] || "",
        tcs: 0,
        lines: [],
        amazon: { value: 0, igst: 0, cgst: 0, sgst: 0 },
      });
    }
    const d = map.get(number);
    // Refund rows already carry negative amounts: credit-note values stay negative here (sales reduced).
    const l = linesOf(r, 1);
    d.lines.push(...l.lines);
    d.orders.add(r["Order Id"]);
    d.amazon.value = round2(d.amazon.value + l.value);
    for (const h of ["igst", "cgst", "sgst"]) d.amazon[h] = round2(d.amazon[h] + l.tax[h]);
    d.tcs = round2(d.tcs + (num(r["Tcs Igst Amount"]) + num(r["Tcs Cgst Amount"]) + num(r["Tcs Sgst Amount"]) + num(r["Tcs Utgst Amount"])));
  }
  const fin = (d) => {
    d.orders = [...d.orders].filter(Boolean);
    d.pos = d.shipTo.state || d.billTo.state || (d.buyerGstin ? d.buyerGstin.slice(0, 2) : "");
    d.taxable = round2(d.lines.reduce((t, l) => t + l.taxable, 0));
    d.amazon.tax = round2(d.amazon.igst + d.amazon.cgst + d.amazon.sgst);
    return d;
  };
  return { invoices: [...invoices.values()].map(fin), creditNotes: [...notes.values()].map(fin), skipped };
}

/* ---------------- Amazon's GSTR-1 workbook ---------------- */
// Rows of a sheet after its header row (the row containing `firstHeader`), as objects.
function sheetRows(wb, name, firstHeader) {
  const XLSX = require("xlsx");
  const ws = wb.Sheets[name];
  if (!ws) return [];
  const all = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
  const h = all.findIndex((r) => String(r[0]).trim() === firstHeader);
  if (h < 0) return [];
  const head = all[h].map((x) => String(x).trim());
  return all.slice(h + 1).filter((r) => r.some((x) => x !== "" && x !== null)).map((r) => Object.fromEntries(head.map((k, i) => [k, r[i]])));
}

function readGstr1(wb) {
  const pos = (v) => stateCode(String(v || ""));
  const rate = (v) => snapRate(num(v) * (num(v) <= 1 ? 100 : 1));
  return {
    b2b: sheetRows(wb, "B2B", "GSTIN/UIN of Recipient").map((r) => ({ gstin: String(r["GSTIN/UIN of Recipient"]).trim(), number: String(r["Invoice Number"]).trim(), date: r["Invoice date"], value: num(r["Invoice Value"]), pos: pos(r["Place Of Supply"]), rate: rate(r.Rate), taxable: num(r["Taxable Value"]) })),
    cdnr: sheetRows(wb, "B2B CN (cdnr)", "GSTIN/UIN of Recipient").map((r) => ({ gstin: String(r["GSTIN/UIN of Recipient"]).trim(), number: String(r["Note Number"]).trim(), date: r["Note Date"], type: r["Note Type"], value: num(r["Note Value"]), pos: pos(r["Place Of Supply"]), rate: rate(r.Rate), taxable: num(r["Taxable Value"]), invoice: String(r["Invoice/Advance Receipt Number"] || "").trim() })),
    cdnur: sheetRows(wb, "B2CL CN (cdnur)", "UR Type").map((r) => ({ number: String(r["Note Number"]).trim(), value: num(r["Note Value"]), pos: pos(r["Place Of Supply"]), rate: rate(r.Rate), taxable: num(r["Taxable Value"]) })),
    b2cl: sheetRows(wb, "B2C Large", "Invoice Number").map((r) => ({ number: String(r["Invoice Number"]).trim(), value: num(r["Invoice Value"]), pos: pos(r["Place Of Supply"]), rate: rate(r.Rate), taxable: num(r["Taxable Value"]) })),
    b2cs: sheetRows(wb, "B2C Small", "Type").map((r) => ({ pos: pos(r["Place Of Supply"]), rate: rate(r.Rate), taxable: num(r["Taxable Value"]) })),
    hsn: sheetRows(wb, "HSN Summary", "HSN").map((r) => ({ hsn: String(r.HSN).trim(), rate: rate(r.Rate), qty: num(r["Total Quantity"]), value: num(r["Total Value"]), taxable: num(r["Taxable Value"]), igst: num(r["Integrated Tax Amount"]), cgst: num(r["Central Tax Amount"]), sgst: num(r["State/UT Tax Amount"]) })),
  };
}

module.exports = { parseCsv, unpack, plan, readGstr1, dateOf, iso, num };
