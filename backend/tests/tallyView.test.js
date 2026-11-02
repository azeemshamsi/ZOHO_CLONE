const test = require("node:test");
const assert = require("node:assert");
const { movements } = require("../src/utils/ledger");
const TV = require("../src/utils/tallyView");

// April: opening stock 50,000; bill 10,000 on "Purchase Local @ 5%" (tracked stock); sold for 6,000 at a cost of 4,000.
// Lines as utils/ledger.js buildEntries makes them (stock movements tagged).
const D = (d) => new Date(`2026-04-${d}T00:00:00Z`);
const entries = [
  { date: D("01"), type: "Opening Stock", lines: [{ account: "inventory", debit: 50000, credit: 0, openingStock: true }, { account: "opening_equity", debit: 0, credit: 50000 }] },
  { date: D("05"), type: "Bill", lines: [
    { account: "pl5", debit: 10000, credit: 0 },
    { account: "pl5", debit: 0, credit: 10000, stock: true },
    { account: "inventory", debit: 10000, credit: 0, stock: true },
    { account: "ap", debit: 0, credit: 10000 },
  ] },
  { date: D("10"), type: "Invoice", lines: [
    { account: "ar", debit: 6000, credit: 0 },
    { account: "os5", debit: 0, credit: 6000 },
    { account: "cogs", debit: 4000, credit: 0, stock: true },
    { account: "inventory", debit: 0, credit: 4000, stock: true },
  ] },
];
const net = (mv, c) => (mv[c] ? Math.round((mv[c].debit - mv[c].credit) * 100) / 100 : 0);

test("live view: stock in Inventory Asset, cost of sales in COGS, purchase ledger nets to 0", () => {
  const mv = movements(entries);
  assert.equal(net(mv, "inventory"), 56000);
  assert.equal(net(mv, "cogs"), 4000);
  assert.equal(net(mv, "pl5"), 0);
});

test("Tally view: purchase ledger in full, Opening Stock line, closing stock from the live books, same profit", () => {
  const t = TV.tallyEntries(entries);
  const mv = movements(t);
  assert.equal(net(mv, "pl5"), 10000);
  assert.equal(net(mv, "_opening_stock"), 50000);
  assert.equal(net(mv, "inventory"), 0);
  assert.equal(net(mv, "cogs"), 0);
  // every entry still balances
  for (const e of t) assert.equal(Math.round(e.lines.reduce((s, l) => s + l.debit - l.credit, 0) * 100), 0);
  const closing = TV.stockValue(entries, D("30"));
  assert.equal(closing, 56000);
  const tallyProfit = 6000 - (50000 + net(mv, "pl5") - closing);
  const liveProfit = 6000 - net(movements(entries), "cogs");
  assert.equal(tallyProfit, liveProfit);
  assert.equal(tallyProfit, 2000);
});
