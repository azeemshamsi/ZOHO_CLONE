/**
 * GST rule 37 (CGST Rules): input tax credit taken on a purchase must be reversed if the supplier isn't paid within
 * 180 days of the invoice date (re-claimed once paid). Unpaid bills by age since the bill date:
 *   over   — more than 180 days, still unpaid (in part): ITC on the unpaid part to reverse
 *   soon   — 151–180 days: pay within the days left to keep the ITC
 */
const Bill = require("../models/Bill");
const { istToday } = require("./time");

const DAY = 86400000;
const LIMIT = 180;
const WARN = 150;
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

async function bills180(org) {
  const today = istToday();
  const docs = await Bill.find({ organization: org, status: { $in: ["open", "partially_paid"] } }, { lineItems: 0 }).lean();
  // B2B: the supplier is GST-registered (GSTIN on the bill, else on the vendor); B2C: unregistered supplier.
  const Vendor = require("../models/Vendor");
  const ids = [...new Set(docs.filter((b) => !b.vendorGstin && b.vendor).map((b) => String(b.vendor)))];
  const vGstin = new Map(ids.length ? (await Vendor.find({ _id: { $in: ids } }, { gstin: 1 }).lean()).map((v) => [String(v._id), v.gstin || ""]) : []);
  // As Tally: what's owed is the supplier's ledger balance. Bills settled outside bill-wise allocation (journals,
  // debit notes, Amazon / Flipkart settlements) still show a balance on the bill, so the ledger's payable is laid
  // on the newest bills first; older ones count as paid. A supplier whose ledger is nil owes nothing.
  const owed = await ledgerPayables(org, [...new Set(docs.map((b) => String(b.vendor || "")).filter(Boolean))]);
  const eff = new Map();
  const byVendor = new Map();
  for (const b of docs) {
    const v = String(b.vendor || "");
    if (!byVendor.has(v)) byVendor.set(v, []);
    byVendor.get(v).push(b);
  }
  for (const [v, list] of byVendor) {
    if (!v || !owed.has(v)) {
      for (const b of list) eff.set(String(b._id), b.balance);
      continue;
    }
    let left = Math.max(0, owed.get(v));
    for (const b of list.sort((x, y) => new Date(y.date) - new Date(x.date))) {
      const e = r2(Math.min(b.balance > 0 ? b.balance : 0, left));
      left = r2(left - e);
      eff.set(String(b._id), e);
    }
  }
  const rows = [];
  for (const b0 of docs) {
    const b = { ...b0, balance: eff.has(String(b0._id)) ? eff.get(String(b0._id)) : b0.balance };
    if (!(b.balance > 0.009)) continue;
    // Bill dates are calendar dates (UTC midnight; imported ones may be India midnight): round to whole days.
    const age = Math.round((today - new Date(b.date)) / DAY);
    if (age <= WARN) continue;
    const gst = r2((b.cgst || 0) + (b.sgst || 0) + (b.igst || 0));
    const itc = b.total > 0 ? r2((gst * b.balance) / b.total) : 0;
    rows.push({
      id: String(b._id),
      vendor: b.vendorName,
      vendorId: String(b.vendor || ""),
      gstin: b.vendorGstin || vGstin.get(String(b.vendor)) || "",
      number: b.billNumber,
      date: b.date,
      age,
      daysLeft: LIMIT - age,
      state: age > LIMIT ? "over" : "soon",
      total: b.total,
      balance: b.balance,
      gst,
      itc,
    });
  }
  for (const r of rows) r.kind = r.gstin ? "b2b" : "b2c";
  rows.sort((a, b) => b.age - a.age);
  const over = rows.filter((r) => r.state === "over");
  const soon = rows.filter((r) => r.state === "soon");
  const tot = (xs, k) => r2(xs.reduce((t, x) => t + (x[k] || 0), 0));
  return { rows, summary: { over: { count: over.length, balance: tot(over, "balance"), itc: tot(over, "itc") }, soon: { count: soon.length, balance: tot(soon, "balance"), itc: tot(soon, "itc") } } };
}

// Each supplier's payable in the books (credit balance on Accounts Payable), from all entries to date.
async function ledgerPayables(org, vendorIds, account = "ap") {
  const out = new Map();
  if (!vendorIds.length) return out;
  const want = new Set(vendorIds);
  const { buildEntries } = require("./ledger");
  // Payables: credit balance on Accounts Payable; receivables (account "ar"): debit balance on Accounts Receivable.
  const sign = account === "ar" ? -1 : 1;
  for (const e of await buildEntries(org, {})) {
    for (const l of e.lines || []) {
      if (l.account !== account || !l.partyId) continue;
      const v = String(l.partyId);
      if (!want.has(v)) continue;
      out.set(v, r2((out.get(v) || 0) + sign * ((l.credit || 0) - (l.debit || 0))));
    }
  }
  for (const v of want) if (!out.has(v)) out.set(v, 0);
  return out;
}

module.exports = { bills180, ledgerPayables, LIMIT, WARN };
