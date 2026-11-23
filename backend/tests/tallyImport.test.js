const test = require("node:test");
const assert = require("node:assert");
const { lineRates } = require("../src/utils/import/tally");

test("mixed GST rates on one voucher follow Tally's per-rate tax ledgers", () => {
  // Wall shelves at 5% and a side table at 18% on one inter-state invoice.
  const rates = lineRates([149996.28, 5081.36], [
    { ledger: "IGST 5%", amount: 7499.81 },
    { ledger: "IGST 18%", amount: 914.64 },
  ]);
  assert.deepStrictEqual(rates, [5, 18]);
});

test("CGST + SGST ledgers count as the combined rate, untaxed lines get 0", () => {
  const rates = lineRates([16335.27, 181.26], [
    { ledger: "Input CGST 9%", amount: 1470.17 },
    { ledger: "Input SGST 9%", amount: 1470.18 },
  ]);
  assert.deepStrictEqual(rates, [18, 0]);
});

test("one rate for every line when it matches", () => {
  assert.deepStrictEqual(lineRates([1000, 500], [{ ledger: "Output IGST", amount: 270 }]), [18, 18]);
});

test("a cash sale with stock is an invoice to Cash Sales, paid into Cash at once (its stock moves)", () => {
  const fs = require("fs");
  const path = require("path");
  const { parseFile } = require("../src/utils/import/parse");
  const { normalise } = require("../src/utils/import/tally");
  const p = parseFile(
    "x.xml",
    fs.readFileSync(path.join(__dirname, "fixtures/tallyCashSale.xml")),
  );
  const { records } = normalise(p.xml, { ledgers: {} });
  assert.strictEqual(records.journals.length, 0);
  const [inv] = records.invoices;
  assert.strictEqual(inv.party, "Cash Sales");
  assert.strictEqual(inv.lines[0].name, "Wall Shelves 5%");
  assert.strictEqual(inv.lines[0].quantity, 10);
  assert.strictEqual(inv.replacesJournal, "Sales SH/26-27/44");
  const [pay] = records.payments;
  assert.deepStrictEqual(
    [pay.party, pay.amount, pay.depositTo, pay.mode],
    ["Cash Sales", inv.total, "Cash", "cash"],
  );
  assert.deepStrictEqual(pay.allocations, [{ number: inv.number, amount: inv.total }]);
  assert.ok(records.customers.some((c) => c.displayName === "Cash Sales"));
});
