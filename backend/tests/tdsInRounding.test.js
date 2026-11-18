// Bills with TDS posted to Rounding & Adjustments: found with a TDS rate guess, moved to the TDS ledger
// with the paise of round-off left in Rounding.
const test = require("node:test");
const assert = require("node:assert");
const express = require("express");
const Bill = require("../src/models/Bill");
const Account = require("../src/models/Account");
const org = "64b0000000000000000000aa";
const tds = { _id: "64b0000000000000000000f1", name: "TDS Payable 194C", group: "Other Current Liability" };
const bills = [
  { _id: "64b000000000000000000001", billNumber: "BD1", vendor: "v1", vendorName: "Blue Dart", date: new Date("2026-10-31"), adjustment: -1652.5, subTotal: 82625, status: "open" },
  { _id: "64b000000000000000000002", billNumber: "BD2", vendor: "v1", vendorName: "Blue Dart", date: new Date("2026-10-31"), adjustment: -5.24, subTotal: 252, status: "open" },
  { _id: "64b000000000000000000003", billNumber: "AM1", vendor: "v2", vendorName: "Amazon", date: new Date("2026-10-31"), adjustment: -0.31, subTotal: 100, status: "open" },
  { _id: "64b000000000000000000004", billNumber: "OLD", vendor: "v1", vendorName: "Blue Dart", date: new Date("2026-09-30"), adjustment: -20, adjustmentAccount: tds._id, subTotal: 1000, status: "paid" },
];
Bill.find = () => ({ lean: async () => bills });
Bill.findOne = (q) => ({ lean: async () => bills.find((b) => b._id === q._id) });
const updates = [];
Bill.updateOne = async (q, u) => updates.push([q._id, u]);
Account.find = () => ({ lean: async () => [tds, { _id: "64b0000000000000000000e1", name: "Freight", group: "Expense" }] });
require("../src/utils/audit").log = async () => {};
const app = express();
app.use(express.json());
app.use((req, res, next) => ((req.org = org), (req.user = { name: "A" }), next()));
app.use("/b", require("../src/routes/bills"));
app.use((err, req, res, next) => res.status(err.status || 500).send({ message: err.message })); // eslint-disable-line no-unused-vars
const server = app.listen(0);
const url = (p) => `http://127.0.0.1:${server.address().port}/b${p}`;
test.after(() => server.close());

test("lists TDS in rounding with rate and the vendor's usual ledger", async () => {
  const d = await (await fetch(url("/tds-in-rounding"))).json();
  assert.deepStrictEqual(d.rows.map((r) => [r.billNumber, r.rate, r.roundOff, r.ledger]), [
    ["BD1", 2, 0, tds._id],
    ["BD2", 2, -0.2, tds._id],
  ]);
  assert.deepStrictEqual(d.ledgers, [{ code: tds._id, name: tds.name }]);
});

test("moves to the TDS ledger keeping the round-off", async () => {
  const r = await fetch(url("/tds-in-rounding/move"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: [{ id: bills[1]._id, account: tds._id }] }) });
  assert.deepStrictEqual(await r.json(), { moved: 1 });
  assert.deepStrictEqual(updates[0], [bills[1]._id, { adjustmentAccount: tds._id, adjustmentRoundOff: -0.2 }]);
  const bad = await fetch(url("/tds-in-rounding/move"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: [{ id: bills[0]._id, account: "64b0000000000000000000e1" }] }) });
  assert.strictEqual(bad.status, 400);
});
