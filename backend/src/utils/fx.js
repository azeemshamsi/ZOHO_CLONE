/**
 * Exchange rates: fetch the latest ₹ rates, and work out year-end revaluation of open
 * foreign-currency invoices and bills.
 */
const { round2 } = require("./http");

// ₹ per 1 unit of each code, from a free API (no key). FX_API_URL can point elsewhere.
async function fetchRates(codes) {
  const url = process.env.FX_API_URL || "https://open.er-api.com/v6/latest/INR";
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`rate service answered ${r.status}`);
    const j = await r.json();
    const per = j.rates || {};
    const out = {};
    for (const c of codes) if (per[c] > 0) out[c] = Math.round((1 / per[c]) * 10000) / 10000;
    return { rates: out, source: j.provider || new URL(url).host, asOf: j.time_last_update_utc || new Date().toUTCString() };
  } finally {
    clearTimeout(t);
  }
}

// Update every currency of an organization; returns what changed.
async function refreshOrg(org) {
  const Currency = require("../models/Currency");
  const list = await Currency.find({ organization: org });
  if (!list.length) return { updated: [], missing: [] };
  const { rates, source } = await fetchRates(list.map((c) => c.code));
  const today = require("./time").istToday();
  const updated = [];
  for (const c of list) {
    const r = rates[c.code];
    if (!r) continue;
    if (r !== c.rate) c.rates.push({ date: today, rate: r });
    c.rate = r;
    c.rateSource = source;
    c.rateUpdatedAt = new Date();
    await c.save();
    updated.push({ code: c.code, rate: r });
  }
  return { updated, missing: list.filter((c) => !rates[c.code]).map((c) => c.code), source };
}

// Daily: organizations with automatic rates switched on.
async function autoRefresh() {
  const Organization = require("../models/Organization");
  const orgs = await Organization.find({ fxAutoUpdate: true }, { _id: 1, fxUpdatedAt: 1 });
  for (const o of orgs) {
    if (o.fxUpdatedAt && Date.now() - o.fxUpdatedAt.getTime() < 20 * 3600 * 1000) continue;
    try {
      await refreshOrg(o._id);
      await Organization.updateOne({ _id: o._id }, { fxUpdatedAt: new Date() });
    } catch (e) {
      console.error("Exchange rate update failed:", e.message);
    }
  }
}

/**
 * Open foreign-currency invoices and bills on `date`, revalued at `rate`.
 * Gain is positive. Invoices gain when the rupee weakens; bills lose.
 */
async function revaluation(org, currency, date, rate) {
  const Invoice = require("../models/Invoice");
  const Bill = require("../models/Bill");
  const Payment = require("../models/Payment");
  const VendorPayment = require("../models/VendorPayment");
  const CreditNote = require("../models/CreditNote");
  const VendorCredit = require("../models/VendorCredit");
  const { raw } = require("../config/baseCurrency");
  const end = new Date(date);
  end.setUTCHours(23, 59, 59, 999);
  const live = { organization: org, currency, status: { $nin: ["draft", "void"] }, date: { $lte: end } };
  const [invoices, bills, pays, vpays, cns, vcs] = await raw(() =>
    Promise.all([
      Invoice.find(live).lean(),
      Bill.find(live).lean(),
      Payment.find({ organization: org, date: { $lte: end } }).lean(),
      VendorPayment.find({ organization: org, date: { $lte: end } }).lean(),
      CreditNote.find({ organization: org, date: { $lte: end } }).lean(),
      VendorCredit.find({ organization: org, date: { $lte: end } }).lean(),
    ])
  );
  // Amount settled on each document up to the date (payments + credits).
  const settled = {};
  const add = (id, amt) => (settled[String(id)] = (settled[String(id)] || 0) + amt);
  pays.forEach((p) => p.allocations.forEach((a) => add(a.invoice, a.amount)));
  vpays.forEach((p) => p.allocations.forEach((a) => add(a.bill, a.amount)));
  cns.forEach((c) => (c.applications || []).filter((a) => new Date(a.date) <= end).forEach((a) => add(a.invoice, a.amount)));
  vcs.forEach((c) => (c.applications || []).filter((a) => new Date(a.date) <= end).forEach((a) => add(a.bill, a.amount)));
  const lines = [];
  for (const i of invoices) {
    const bal = round2(i.total - (settled[String(i._id)] || 0));
    if (bal <= 0) continue;
    lines.push({ kind: "invoice", id: i._id, number: i.invoiceNumber, party: i.customerName, balance: bal, bookRate: i.exchangeRate, gain: round2(bal * (rate - i.exchangeRate)) });
  }
  for (const b of bills) {
    const bal = round2(b.total - (settled[String(b._id)] || 0));
    if (bal <= 0) continue;
    lines.push({ kind: "bill", id: b._id, number: b.billNumber, party: b.vendorName, balance: bal, bookRate: b.exchangeRate, gain: round2(bal * (b.exchangeRate - rate)) });
  }
  return { lines, total: round2(lines.reduce((s, l) => s + l.gain, 0)) };
}

module.exports = { fetchRates, refreshOrg, autoRefresh, revaluation };
