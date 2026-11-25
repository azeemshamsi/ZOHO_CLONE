const test = require("node:test");
const assert = require("node:assert");
const Bill = require("../src/models/Bill");
const VendorCredit = require("../src/models/VendorCredit");
const b180 = require("../src/utils/bills180");
const V = "64b000000000000000000001";
const W = "64b000000000000000000002";
let owed;
b180.ledgerPayables = async () => owed;
Bill.find = () => ({ lean: async () => [
  { _id: "b1", vendor: V, vendorName: "Amazon", billNumber: "A1", date: "2026-04-30", balance: 1000 },
  { _id: "b2", vendor: V, vendorName: "Amazon", billNumber: "A2", date: "2026-05-31", balance: 500 },
  { _id: "b3", vendor: W, vendorName: "Steel Co", billNumber: "S1", date: "2026-06-01", balance: 300 },
] });
VendorCredit.find = () => ({ lean: async () => [{ _id: "c1", vendor: V, vendorName: "Amazon", number: "D1", date: "2026-04-30", balance: 200 }] });
const LM = require("../src/utils/ledgerMatch");

test("nil ledger: every open bill and debit note is settled", async () => {
  owed = new Map([[V, 0], [W, 300]]);
  const p = await LM.plan("o");
  assert.strictEqual(p.length, 1); // Steel Co's bills already match its ledger
  assert.deepStrictEqual(p[0].changes.map((c) => [c.number, c.settle, c.left]), [["A1", 1000, 0], ["D1", 200, 0], ["A2", 500, 0]]);
  assert.strictEqual(p[0].after, 0);
});

test("ledger owes 600: newest bills keep 600, older settled", async () => {
  owed = new Map([[V, 600], [W, 300]]);
  const p = await LM.plan("o");
  assert.deepStrictEqual(p[0].changes.filter((c) => c.type === "bill").map((c) => [c.number, c.settle, c.left]), [["A1", 900, 100]]);
  assert.strictEqual(p[0].after, 600);
});
