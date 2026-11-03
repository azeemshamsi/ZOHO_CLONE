/**
 * What each customer / vendor owes or is owed, with ageing, the way Tally's bill-wise outstanding works:
 * open invoices (bills) and journal debits (credits for vendors) are the dues; on-account receipts
 * (payments), open credit notes (vendor credits) and journal credits are set against the oldest dues first.
 */
const { round2 } = require("./http");

const DAY = 86400000;
const BUCKETS = ["1-15", "16-30", "31-45", "45+"];

async function partyAging(org, kind, today) {
  const sales = kind === "customer";
  const Doc = require(`../models/${sales ? "Invoice" : "Bill"}`);
  const Pay = require(`../models/${sales ? "Payment" : "VendorPayment"}`);
  const Note = require(`../models/${sales ? "CreditNote" : "VendorCredit"}`);
  const Journal = require("../models/Journal");
  const Party = require(`../models/${sales ? "Customer" : "Vendor"}`);
  const acc = sales ? "ar" : "ap";
  const [docs, pays, notes, journals] = await Promise.all([
    Doc.find({ organization: org, status: { $nin: ["draft", "void", "paid"] }, balance: { $gt: 0 } }, { [kind]: 1, date: 1, dueDate: 1, balance: 1, exchangeRate: 1 }).lean(),
    Pay.find({ organization: org, unusedAmount: { $gt: 0 } }, { [kind]: 1, date: 1, unusedAmount: 1, exchangeRate: 1 }).lean(),
    Note.find({ organization: org, status: "open", balance: { $gt: 0 } }, { [kind]: 1, date: 1, balance: 1, exchangeRate: 1 }).lean(),
    Journal.find({ organization: org, [`lines.${kind}`]: { $ne: null } }, { date: 1, lines: 1 }).lean(),
  ]);
  const P = new Map();
  const get = (id) => {
    const k = String(id);
    if (!P.has(k)) P.set(k, { id: k, dues: [], credit: 0 });
    return P.get(k);
  };
  const r = (d) => Number(d.exchangeRate) || 1;
  for (const d of docs) get(d[kind]).dues.push({ due: d.dueDate || d.date, amount: round2(d.balance * r(d)) });
  for (const p of pays) get(p[kind]).credit += p.unusedAmount * r(p);
  for (const n of notes) get(n[kind]).credit += n.balance * r(n);
  for (const j of journals)
    for (const l of j.lines) {
      if (!l[kind] || l.account !== acc) continue;
      const v = sales ? l.debit - l.credit : l.credit - l.debit;
      if (v > 0) get(l[kind]).dues.push({ due: j.date, amount: v });
      else if (v < 0) get(l[kind]).credit += -v;
    }
  const names = new Map((await Party.find({ organization: org, _id: { $in: [...P.keys()] } }, { displayName: 1 }).lean()).map((p) => [String(p._id), p.displayName]));
  const out = { due: 0, advances: 0, current: 0, overdue: 0, buckets: Object.fromEntries(BUCKETS.map((b) => [b, 0])), parties: [] };
  for (const p of P.values()) {
    p.dues.sort((a, b) => new Date(a.due) - new Date(b.due));
    let credit = round2(p.credit);
    let net = 0;
    for (const d of p.dues) {
      const take = Math.min(credit, d.amount);
      credit = round2(credit - take);
      const left = round2(d.amount - take);
      if (left <= 0) continue;
      net += left;
      const late = Math.floor((today - new Date(d.due)) / DAY);
      if (late <= 0) out.current += left;
      else {
        out.overdue += left;
        out.buckets[late <= 15 ? "1-15" : late <= 30 ? "16-30" : late <= 45 ? "31-45" : "45+"] += left;
      }
    }
    net = round2(net - credit);
    if (net > 0) out.due += net;
    else out.advances += -net;
    if (net) out.parties.push({ id: p.id, name: names.get(p.id) || "(deleted)", net });
  }
  for (const k of ["due", "advances", "current", "overdue"]) out[k] = round2(out[k]);
  for (const b of BUCKETS) out.buckets[b] = round2(out.buckets[b]);
  out.parties.sort((a, b) => b.net - a.net);
  return out;
}

module.exports = { partyAging };
