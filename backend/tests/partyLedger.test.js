// Party Ledger: opening before From, vouchers with the other ledger, running Dr/Cr balance, closing.
const test = require("node:test");
const assert = require("node:assert");
const ledger = require("../src/utils/ledger");
const Customer = require("../src/models/Customer");
const id = "64b000000000000000000001";
ledger.chartOfAccounts = async () => [{ code: "ar", name: "Accounts Receivable" }, { code: "sales18", name: "Sales GST 18%" }, { code: "hdfc", name: "HDFC Bank" }, { code: "igst", name: "Output IGST" }];
const e = (date, type, number, lines) => ({ date: new Date(date), type, id: number, number, lines });
ledger.buildEntries = async () => [
  e("2026-03-20", "Invoice", "INV1", [{ account: "ar", debit: 1180, credit: 0, partyId: id }, { account: "sales18", debit: 0, credit: 1000 }, { account: "igst", debit: 0, credit: 180 }]),
  e("2026-04-05", "Invoice", "INV2", [{ account: "ar", debit: 2360, credit: 0, partyId: id }, { account: "sales18", debit: 0, credit: 2000 }, { account: "igst", debit: 0, credit: 360 }]),
  e("2026-04-10", "Customer Payment", "PAY1", [{ account: "hdfc", debit: 3000, credit: 0 }, { account: "ar", debit: 0, credit: 3000, partyId: id }]),
  e("2026-04-11", "Invoice", "OTHER", [{ account: "ar", debit: 500, credit: 0, partyId: "64b000000000000000000009" }, { account: "sales18", debit: 0, credit: 500 }]),
];
Customer.findOne = () => ({ lean: async () => ({ _id: id, displayName: "Asha Traders", gstin: "27ABCDE1234F1Z5", billingAddress: { street: "1 MG Road", city: "Pune", pincode: "411001" } }) });
const { REPORTS } = require("../src/utils/reportCatalog");

test("party ledger figures", async () => {
  const d = await REPORTS["party-ledger"]({ org: "o" }, { from: "2026-04-01", to: "2026-04-30", party: `customer:${id}` });
  assert.strictEqual(d.party.name, "Asha Traders");
  assert.strictEqual(d.opening, 1180);
  assert.deepStrictEqual(d.rows.map((r) => [r.number, r.vchType, r.particulars, r.debit, r.credit, r.balance]), [
    ["INV2", "Sales", "Sales GST 18%", 2360, 0, 3540],
    ["PAY1", "Receipt", "HDFC Bank", 0, 3000, 540],
  ]);
  assert.strictEqual(d.rows[0].more, 1);
  assert.strictEqual(d.closing, 540);
  assert.strictEqual(d.party.address, "1 MG Road, Pune, 411001");
});

test("no party chosen", async () => {
  const d = await REPORTS["party-ledger"]({ org: "o" }, { from: "2026-04-01", to: "2026-04-30" });
  assert.strictEqual(d.party, null);
});
