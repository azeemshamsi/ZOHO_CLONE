/**
 * Sales / purchase ledgers from use: income accounts that invoices and credit notes post to are sales ledgers;
 * accounts set as the purchase ledger of bills / vendor credits are purchase ledgers (as in Tally).
 * Only accounts with no kind yet are changed. Runs after Tally imports and once for existing data.
 */
const mongoose = require("mongoose");
const Account = require("../../models/Account");
const Invoice = require("../../models/Invoice");
const CreditNote = require("../../models/CreditNote");
const Bill = require("../../models/Bill");
const VendorCredit = require("../../models/VendorCredit");

const ids = (set) => [...set].filter((c) => /^[0-9a-f]{24}$/i.test(c)).map((c) => new mongoose.Types.ObjectId(c));

async function markLedgerKinds(org) {
  const sales = new Set();
  const purchase = new Set();
  const used = (docs, into, withLines) => {
    for (const d of docs) {
      if (d.ledger) into.add(String(d.ledger));
      if (withLines) for (const l of d.lineItems || []) if (l.account) into.add(String(l.account));
    }
  };
  const f = org ? { organization: org } : {};
  const p = { ledger: 1, "lineItems.account": 1, organization: 1 };
  used(await Invoice.find(f, p).lean(), sales, true);
  used(await CreditNote.find(f, p).lean(), sales, true);
  used(await Bill.find(f, { ledger: 1 }).lean(), purchase, false);
  used(await VendorCredit.find(f, { ledger: 1 }).lean(), purchase, false);
  const s = await Account.updateMany({ _id: { $in: ids(sales) }, group: { $in: ["Income", "Other Income"] }, ledgerKind: { $in: ["", null] }, ...f }, { ledgerKind: "sales" });
  const q = await Account.updateMany({ _id: { $in: ids(purchase) }, ledgerKind: { $in: ["", null] }, ...f }, { ledgerKind: "purchase" });
  return { sales: s.modifiedCount, purchase: q.modifiedCount };
}

module.exports = { markLedgerKinds };
