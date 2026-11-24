/**
 * Move every entry of one ledger to another: documents' sales/purchase ledger and line accounts, journal lines,
 * expenses, and its place in ledger groups. → { "invoices": n, … } (what moved).
 */
const LedgerGroup = require("../models/LedgerGroup");

async function moveEntries(org, from, into, intoName = "") {
    const moved = {};
    const docModels = { Invoice: "invoices", CreditNote: "credit notes", Bill: "bills", VendorCredit: "vendor credits", Quote: "quotes", SalesOrder: "sales orders", PurchaseOrder: "purchase orders" };
    for (const [m, label] of Object.entries(docModels)) {
      const M = require(`../models/${m}`);
      const seen = new Set();
      for (const q of [{ ledger: from }, { "lineItems.account": from }]) {
        for (const d of await M.find({ organization: org, ...q }, { ledger: 1, lineItems: 1 }).lean()) {
          if (seen.has(String(d._id))) continue;
          seen.add(String(d._id));
          const set = {};
          if (d.ledger === from) set.ledger = into;
          if ((d.lineItems || []).some((l) => l.account === from)) set.lineItems = d.lineItems.map((l) => (l.account === from ? { ...l, account: into } : l));
          await M.updateOne({ _id: d._id, organization: org }, { $set: set });
        }
      }
      if (seen.size) moved[label] = seen.size;
    }
    const Journal = require("../models/Journal");
    let nj = 0;
    for (const j of await Journal.find({ organization: org, "lines.account": from }, { lines: 1 }).lean()) {
      await Journal.updateOne({ _id: j._id, organization: org }, { $set: { lines: j.lines.map((l) => (l.account === from ? { ...l, account: into } : l)) } });
      nj++;
    }
    if (nj) moved.journals = nj;
    const Expense = require("../models/Expense");
    const ne = await Expense.updateMany({ organization: org, account: from }, { $set: { account: into, category: intoName } });
    if (ne.modifiedCount) moved.expenses = ne.modifiedCount;
    for (const g of await LedgerGroup.find({ organization: org })) {
      if (!(g.members || []).includes(from)) continue;
      g.members = [...new Set(g.members.map((m) => (m === from ? into : m)))];
      await g.save();
    }
  return moved;
}

module.exports = { moveEntries };
