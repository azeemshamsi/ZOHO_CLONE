// Stock Summary (Tally): opening / inward / outward / closing per item; value not tied to items on its own line.
const test = require("node:test");
const assert = require("node:assert");
const ledger = require("../src/utils/ledger");
const inventory = require("../src/utils/inventory");
const Item = require("../src/models/Item");
ledger.chartOfAccounts = async () => [{ code: "inventory", name: "Inventory Asset", group: "Stock" }];
const e = (date, lines) => ({ date: new Date(date), type: "Journal", id: date, lines });
ledger.buildEntries = async () => [
  e("2026-03-31", [{ account: "inventory", debit: 1100, credit: 0 }]),
  e("2026-04-05", [{ account: "inventory", debit: 500, credit: 0 }]),
  e("2026-04-10", [{ account: "inventory", debit: 0, credit: 300 }]),
];
const it = "64b000000000000000000001";
inventory.loadStock = async () => ({
  items: {
    [it]: {
      qty: 12,
      value: 1200,
      moves: [
        { date: "2026-03-31", qty: 10, qtyIn: 10, qtyOut: 0, value: 1000, stockValue: 1000 },
        { date: "2026-04-05", qty: 15, qtyIn: 5, qtyOut: 0, value: 500, stockValue: 1500 },
        { date: "2026-04-10", qty: 12, qtyIn: 0, qtyOut: 3, value: -300, stockValue: 1200 },
      ],
    },
  },
});
Item.find = () => ({ sort: () => ({ lean: async () => [{ _id: it, name: "Brass Lamp", sku: "BL1", category: "Lamps" }] }) });
const { REPORTS } = require("../src/utils/reportCatalog");

test("stock summary per item, totals equal the books", async () => {
  const d = await REPORTS["stock-summary"]({ org: "o" }, { from: "2026-04-01", to: "2026-04-30" });
  const [r, extra] = d.rows;
  assert.deepStrictEqual([r.oQty, r.oVal, r.iQty, r.iVal, r.xQty, r.xVal, r.cQty, r.cRate, r.cVal], [10, 1000, 5, 500, 3, 300, 12, 100, 1200]);
  assert.strictEqual(extra.oVal, 100);
  assert.strictEqual(extra.cVal, 100);
  assert.strictEqual(d.rows.length, 2);
});
