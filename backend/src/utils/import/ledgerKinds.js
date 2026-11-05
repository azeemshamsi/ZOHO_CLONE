/**
 * Sales / purchase ledgers from use: income accounts that invoices and credit notes post to (and income accounts
 * named like a sales ledger, "Sale 18% …") are sales ledgers; accounts set as the purchase ledger of bills /
 * vendor credits are purchase ledgers (as in Tally). Only accounts with no kind yet change.
 * Matching is done here and updates go by _id: "blank or missing" queries are unreliable on the Oracle MongoDB API.
 */
const Account = require("../../models/Account");
const Invoice = require("../../models/Invoice");
const CreditNote = require("../../models/CreditNote");
const Bill = require("../../models/Bill");
const VendorCredit = require("../../models/VendorCredit");

const INCOME = ["Income", "Other Income"];
const SALES_NAME = /\bsales?\b|\bsale\s*\d|outstate|out\s*state|interstate|local\s*sale|export\s*sale/i;

async function markLedgerKinds(org) {
  const f = org ? { organization: org } : {};
  const sales = new Set();
  const purchase = new Set();
  for (const d of await Invoice.find(f, { ledger: 1, "lineItems.account": 1 }).lean()) {
    if (d.ledger) sales.add(String(d.ledger));
    for (const l of d.lineItems || []) if (l.account) sales.add(String(l.account));
  }
  for (const d of await CreditNote.find(f, { ledger: 1, "lineItems.account": 1 }).lean()) {
    if (d.ledger) sales.add(String(d.ledger));
    for (const l of d.lineItems || []) if (l.account) sales.add(String(l.account));
  }
  for (const d of await Bill.find(f, { ledger: 1 }).lean()) if (d.ledger) purchase.add(String(d.ledger));
  for (const d of await VendorCredit.find(f, { ledger: 1 }).lean()) if (d.ledger) purchase.add(String(d.ledger));

  const accounts = await Account.find(f, { name: 1, group: 1, ledgerKind: 1 }).lean();
  const toSales = [];
  const toPurchase = [];
  for (const a of accounts) {
    if (a.ledgerKind) continue;
    const id = String(a._id);
    if (INCOME.includes(a.group) && (sales.has(id) || SALES_NAME.test(a.name || ""))) toSales.push(a._id);
    else if (purchase.has(id)) toPurchase.push(a._id);
  }
  if (toSales.length) await Account.updateMany({ _id: { $in: toSales } }, { $set: { ledgerKind: "sales" } });
  if (toPurchase.length) await Account.updateMany({ _id: { $in: toPurchase } }, { $set: { ledgerKind: "purchase" } });
  return { sales: toSales.length, purchase: toPurchase.length, accounts: accounts.length, usedBySales: sales.size };
}

module.exports = { markLedgerKinds };
