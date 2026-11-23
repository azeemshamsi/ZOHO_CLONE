// Cartage lines: two ledgers — GST added on top, or included in the amount entered.
const test = require("node:test");
const assert = require("node:assert");
const { computeTotals } = require("../src/utils/gst");
const { SYSTEM_ACCOUNTS } = require("../src/utils/ledger");

test("cartage ledgers exist for every company", () => {
  const codes = (SYSTEM_ACCOUNTS || []).map((a) => a.code);
  assert.ok(codes.includes("cartage_excl") && codes.includes("cartage_incl"));
});

test("cartage exclusive of GST: tax on top; inclusive: the amount entered includes the tax", () => {
  const base = { orgState: "09", placeOfSupply: "09" };
  const ex = computeTotals({
    ...base,
    lineItems: [
      {
        name: "Cartage",
        quantity: 1,
        rate: 1000,
        taxRate: 18,
        account: "cartage_excl",
      },
    ],
  });
  assert.deepStrictEqual(
    [ex.subTotal, ex.cgst, ex.sgst, ex.total],
    [1000, 90, 90, 1180],
  );
  const inc = computeTotals({
    ...base,
    lineItems: [
      {
        name: "Cartage",
        quantity: 1,
        rate: 0,
        grossRate: 1180,
        taxInclusive: true,
        taxRate: 18,
        account: "cartage_incl",
      },
    ],
  });
  assert.deepStrictEqual(
    [inc.subTotal, inc.cgst, inc.sgst, inc.total],
    [1000, 90, 90, 1180],
  );
  const odd = computeTotals({
    orgState: "09",
    placeOfSupply: "27",
    lineItems: [
      {
        name: "Cartage",
        quantity: 1,
        grossRate: 500,
        taxInclusive: true,
        taxRate: 18,
      },
    ],
  });
  assert.ok(Math.abs(odd.total - 500) <= 0.01, `total ${odd.total}`);
});
