const test = require("node:test");
const assert = require("node:assert");
const { computeTotals } = require("../src/utils/gst");

test("intra-state supply splits GST into CGST and SGST", () => {
  const r = computeTotals({
    orgState: "27",
    placeOfSupply: "27",
    lineItems: [{ name: "Chair", quantity: 2, rate: 1000, discount: 10, taxRate: 18 }],
  });
  assert.equal(r.isInterState, false);
  assert.equal(r.subTotal, 1800);
  assert.equal(r.cgst, 162);
  assert.equal(r.sgst, 162);
  assert.equal(r.igst, 0);
  assert.equal(r.total, 2124);
});

test("inter-state supply charges IGST", () => {
  const r = computeTotals({
    orgState: "27",
    placeOfSupply: "07",
    lineItems: [
      { name: "A", quantity: 1, rate: 500, taxRate: 12 },
      { name: "B", quantity: 3, rate: 100, taxRate: 5 },
    ],
    shippingCharge: 50,
    adjustment: -0.5,
  });
  assert.equal(r.isInterState, true);
  assert.equal(r.subTotal, 800);
  assert.equal(r.igst, 75);
  assert.equal(r.cgst + r.sgst, 0);
  assert.equal(r.total, 924.5);
});
