/**
 * What each customer / vendor owes or is owed, with ageing: each party's ledger balance (as in Tally), its
 * receipts / payments / credit notes / journals set against its oldest dues first.
 */
const { round2 } = require("./http");

const DAY = 86400000;
const BUCKETS = ["1-15", "16-30", "31-45", "45+"];

async function partyAging(org, kind, today, entries = null) {
  // From the ledger itself (as Tally's debtors / creditors): each party's balance is the sum of its receivable
  // (payable) lines, whatever voucher posted them — invoices, receipts, journals, credit notes, imports — so dues
  // and advances add up to the ledger. Ageing: the party's credits are set against its oldest debits first.
  const sales = kind === "customer";
  const acc = sales ? "ar" : "ap";
  const Doc = require(`../models/${sales ? "Invoice" : "Bill"}`);
  const Party = require(`../models/${sales ? "Customer" : "Vendor"}`);
  if (!entries) entries = await require("./ledger").buildEntries(org, {});
  const dueOf = new Map((await Doc.find({ organization: org }, { dueDate: 1 }).lean()).map((d) => [String(d._id), d.dueDate]));
  const docType = sales ? "Invoice" : "Bill";
  const P = new Map();
  const get = (id) => {
    const k = String(id);
    if (!P.has(k)) P.set(k, { id: k, name: "", dues: [], credit: 0 });
    return P.get(k);
  };
  for (const e of entries) {
    for (const l of e.lines || []) {
      if (l.account !== acc || !l.partyId) continue;
      if (l.partyName) get(l.partyId).name = l.partyName;
      const v = round2(sales ? l.debit - l.credit : l.credit - l.debit);
      if (v > 0) get(l.partyId).dues.push({ due: (e.type === docType && dueOf.get(String(e.id))) || e.date, amount: v });
      else if (v < 0) get(l.partyId).credit += -v;
    }
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
    if (net) out.parties.push({ id: p.id, name: names.get(p.id) || p.name || "(deleted)", net });
  }
  for (const k of ["due", "advances", "current", "overdue"]) out[k] = round2(out[k]);
  for (const b of BUCKETS) out.buckets[b] = round2(out.buckets[b]);
  out.parties.sort((a, b) => b.net - a.net);
  return out;
}

module.exports = { partyAging };
