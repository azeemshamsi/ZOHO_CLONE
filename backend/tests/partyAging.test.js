const test = require("node:test");
const assert = require("node:assert");
const Invoice = require("../src/models/Invoice");
const Customer = require("../src/models/Customer");
Invoice.find = () => ({ lean: async () => [{ _id: "i1", dueDate: new Date("2026-11-01") }] });
Customer.find = () => ({ lean: async () => [{ _id: "c1", displayName: "Vedanta" }, { _id: "c2", displayName: "Amazon" }] });
const { partyAging } = require("../src/utils/partyAging");

test("dues / advances come from each party's ledger lines, whatever posted them", async () => {
  const E = (date, type, id, lines) => ({ date: new Date(date), type, id, lines });
  const entries = [
    E("2026-10-01", "Invoice", "i1", [{ account: "ar", partyId: "c1", debit: 1000, credit: 0 }]),
    E("2026-10-20", "Journal", "j1", [{ account: "ar", partyId: "c1", debit: 0, credit: 1000 }]), // receipt by journal
    E("2026-10-05", "Invoice", "i2", [{ account: "ar", partyId: "c2", debit: 500, credit: 0 }]),
    E("2026-10-25", "Payment", "p1", [{ account: "ar", partyId: "c2", debit: 0, credit: 800 }]),
    E("2026-10-26", "Journal", "j2", [{ account: "ar", debit: 50, credit: 0 }]), // no party
  ];
  const a = await partyAging("o", "customer", new Date("2026-11-25"), entries);
  assert.deepStrictEqual([a.due, a.advances, a.overdue], [0, 300, 0]);
  assert.deepStrictEqual(a.parties.map((p) => [p.name, p.net]), [["Amazon", -300]]);
});
