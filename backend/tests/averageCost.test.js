// Stock at Average Cost, like Tally: one rate per item per financial year = (start value + purchases) / (start qty + bought).
const test = require("node:test");
const assert = require("node:assert");
const { computeStock } = require("../src/utils/inventory");
const item = {
  _id: "i1",
  trackInventory: true,
  openingStock: 10,
  openingStockRate: 100,
  openingStockDate: new Date("2026-04-01"),
  purchaseRate: 100,
};
const bill = (d, q, amt, id) => ({
  _id: id,
  status: "open",
  date: new Date(d),
  lineItems: [{ item: "i1", quantity: q, amount: amt }],
});
const inv = (d, q, id) => ({
  _id: id,
  status: "sent",
  date: new Date(d),
  lineItems: [{ item: "i1", quantity: q }],
});

test("average: sales costed at the year's rate, closing = qty × rate (Tally's Stock Summary)", () => {
  const r = computeStock({
    items: [item],
    bills: [bill("2026-06-01", 10, 2000, "b1")],
    invoices: [inv("2026-05-01", 5, "v1")],
    costing: "average",
  });
  assert.deepStrictEqual([r.items.i1.qty, r.items.i1.value], [15, 2250]); // rate (1000 + 2000) / 20 = 150
  assert.strictEqual(r.docCost["Invoice|v1"], 750);
  const f = computeStock({
    items: [item],
    bills: [bill("2026-06-01", 10, 2000, "b1")],
    invoices: [inv("2026-05-01", 5, "v1")],
  });
  assert.strictEqual(f.items.i1.value, 2500); // FIFO: 5 @100 left + 10 @200
});

test("average: a new financial year starts from the value carried in", () => {
  const r = computeStock({
    items: [item],
    bills: [
      bill("2026-06-01", 10, 2000, "b1"),
      bill("2027-05-01", 5, 1500, "b2"),
    ],
    invoices: [inv("2026-05-01", 5, "v1"), inv("2027-06-01", 10, "v2")],
    costing: "average",
  });
  // FY26 closing 15 @150 = 2250; FY27 rate (2250 + 1500) / 20 = 187.5; 10 left = 1875
  assert.deepStrictEqual([r.items.i1.qty, r.items.i1.value], [10, 1875]);
  assert.strictEqual(r.docCost["Invoice|v2"], 1875);
});
