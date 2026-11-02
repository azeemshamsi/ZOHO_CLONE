/**
 * Tally view of the books (periodic stock, as Tally shows it). OrdexaGo keeps stock perpetually:
 * bills put tracked stock into Inventory Asset and sales move its cost to Cost of Goods Sold.
 * Tally shows purchases in full on the purchase ledgers, Opening Stock as its own line, and
 * Closing Stock in the P&L. The books are the same; only the presentation changes, so net profit,
 * stock value and every total match the live view.
 */
const { round2 } = require("./http");

const OPENING_STOCK = { code: "_opening_stock", name: "Opening Stock", group: "Other Current Asset", type: "asset", system: true };

// Entries without the stock movements (tagged `stock` in buildEntries); item opening stock posts to Opening Stock.
function tallyEntries(entries) {
  const out = [];
  for (const e of entries) {
    const lines = e.lines.filter((l) => !l.stock).map((l) => (l.openingStock ? { ...l, account: OPENING_STOCK.code } : l));
    if (lines.length) out.push({ ...e, lines });
  }
  return out;
}

// Accounts as Tally names them: the built-in Cost of Goods Sold holds purchases without a ledger.
function tallyAccounts(accounts) {
  return [...accounts.map((a) => (a.code === "cogs" ? { ...a, name: "Purchases" } : a)), OPENING_STOCK];
}

// Stock value (Inventory Asset, live books) up to a date.
function stockValue(entries, to) {
  const end = to ? new Date(to) : null;
  let v = 0;
  for (const e of entries) {
    if (end && new Date(e.date) > end) continue;
    for (const l of e.lines) if (l.account === "inventory") v += l.debit - l.credit;
  }
  return round2(v);
}

module.exports = { tallyEntries, tallyAccounts, stockValue, OPENING_STOCK };
