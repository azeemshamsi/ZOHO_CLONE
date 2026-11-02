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
