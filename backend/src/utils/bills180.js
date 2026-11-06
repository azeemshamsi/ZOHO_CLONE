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
  const rows = [];
  for (const b of docs) {
    if (!(b.balance > 0)) continue;
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

module.exports = { bills180, LIMIT, WARN };
