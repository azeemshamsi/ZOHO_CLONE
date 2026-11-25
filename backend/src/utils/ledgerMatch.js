/**
 * Match open bills and debit notes to the supplier's ledger balance, as Tally does without bill-wise details:
 * payments made by journal, debit notes and marketplace settlements (Amazon, Flipkart) reduce the ledger but were
 * never set against particular bills, so those bills still look unpaid.
 *  - Ledger payable P >= 0: debit notes are all used; the newest bills keep P outstanding, older ones are settled.
 *  - Ledger in debit (they owe you): bills are all settled; the newest debit notes keep that amount, older are used.
 * Only the bill's / debit note's "settled in ledger" amount changes (so balance and status): no entry is posted,
 * no balance in any ledger moves, and Undo puts it back.
 */
const Bill = require("../models/Bill");
const VendorCredit = require("../models/VendorCredit");
const { ledgerPayables } = require("./bills180");
const { settleBill } = require("./salesDoc");

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const newest = (a, b) => new Date(b.date) - new Date(a.date) || String(b._id).localeCompare(String(a._id));

async function plan(org, vendorIds = null) {
  const [bills, credits] = await Promise.all([
    Bill.find({ organization: org, status: { $in: ["open", "partially_paid"] } }, { lineItems: 0 }).lean(),
    VendorCredit.find({ organization: org, status: "open" }, { lineItems: 0 }).lean(),
  ]);
  const vendors = new Map();
  const add = (d, kind) => {
    const v = String(d.vendor || "");
    if (!v || (vendorIds && !vendorIds.includes(v)) || !(d.balance > 0)) return;
    if (!vendors.has(v)) vendors.set(v, { vendor: v, name: d.vendorName || "", bills: [], credits: [] });
    vendors.get(v)[kind].push(d);
  };
  bills.forEach((b) => add(b, "bills"));
  credits.forEach((c) => add(c, "credits"));
  const owed = await ledgerPayables(org, [...vendors.keys()]);
  const out = [];
  for (const g of vendors.values()) {
    const P = owed.get(g.vendor) || 0;
    const billsDue = r2(g.bills.reduce((t, b) => t + b.balance, 0));
    const creditsOpen = r2(g.credits.reduce((t, c) => t + c.balance, 0));
    const changes = [];
    let keepBills = Math.max(0, P);
    for (const b of g.bills.sort(newest)) {
      const keep = r2(Math.min(b.balance, keepBills));
      keepBills = r2(keepBills - keep);
      const settle = r2(b.balance - keep);
      if (settle > 0.009) changes.push({ type: "bill", id: String(b._id), number: b.billNumber, date: b.date, balance: b.balance, settle, left: keep });
    }
    let keepCredits = Math.max(0, -P);
    for (const c of g.credits.sort(newest)) {
      const keep = r2(Math.min(c.balance, keepCredits));
      keepCredits = r2(keepCredits - keep);
      const settle = r2(c.balance - keep);
      if (settle > 0.009) changes.push({ type: "credit", id: String(c._id), number: c.number, date: c.date, balance: c.balance, settle, left: keep });
    }
    if (!changes.length) continue;
    out.push({ vendor: g.vendor, name: g.name, ledger: r2(P), billsDue, creditsOpen, after: r2(billsDue - creditsOpen - changes.reduce((t, x) => t + (x.type === "bill" ? x.settle : -x.settle), 0)), changes: changes.sort((a, b) => new Date(a.date) - new Date(b.date)) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function apply(org, vendorIds) {
  const groups = await plan(org, vendorIds);
  let bills = 0;
  let credits = 0;
  for (const g of groups)
    for (const ch of g.changes) {
      if (ch.type === "bill") {
        const b = await Bill.findOne({ _id: ch.id, organization: org });
        if (!b) continue;
        b.settledInLedger = r2((b.settledInLedger || 0) + ch.settle);
        settleBill(b);
        await b.save();
        bills++;
      } else {
        const c = await VendorCredit.findOne({ _id: ch.id, organization: org });
        if (!c) continue;
        c.settledInLedger = r2((c.settledInLedger || 0) + ch.settle);
        c.balance = r2(Math.max(0, c.balance - ch.settle));
        if (c.balance <= 0) c.status = "closed";
        await c.save();
        credits++;
      }
    }
  return { vendors: groups.length, bills, credits };
}

// Undo: every "settled in ledger" amount back to 0 (for these suppliers, or all).
async function undo(org, vendorIds = null) {
  const q = { organization: org, settledInLedger: { $gt: 0 } };
  let bills = 0;
  let credits = 0;
  for (const b of await Bill.find(q)) {
    if (vendorIds && !vendorIds.includes(String(b.vendor))) continue;
    b.settledInLedger = 0;
    settleBill(b);
    await b.save();
    bills++;
  }
  for (const c of await VendorCredit.find(q)) {
    if (vendorIds && !vendorIds.includes(String(c.vendor))) continue;
    c.balance = r2(c.balance + c.settledInLedger);
    c.settledInLedger = 0;
    if (c.balance > 0 && c.status === "closed") c.status = "open";
    await c.save();
    credits++;
  }
  return { bills, credits };
}

module.exports = { plan, apply, undo };
