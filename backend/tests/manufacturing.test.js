// Manufacturing journal like Tally: components + additional cost (labour) = effective cost, shared by % of cost.
const test = require("node:test");
const assert = require("node:assert");
const { manufacture } = require("../src/routes/inventoryAdjustments");

test("MANUFACTURING 4: 10 beds at 98% of ₹82,355 = ₹8,070.79 each; scrap 2%", () => {
  const data = {
    reason: "Manufacturing",
    additionalCosts: [{ account: "labour", percent: 30 }],
    lines: [
      { name: "Wooden Bed", quantityAdjusted: 10, costPrice: 0 },
      {
        name: "WAST AND SCRAP",
        quantityAdjusted: 100,
        costPercent: 2,
        costPrice: 0,
      },
      { name: "Wood", quantityAdjusted: -500, rate: 30 },
      { name: "Plywood", quantityAdjusted: -30, rate: 500 },
      { name: "Foam Sheet", quantityAdjusted: -20, rate: 350 },
      { name: "Holland", quantityAdjusted: -50, rate: 350 },
      { name: "Hardware", quantityAdjusted: -10, rate: 150 },
      { name: "Paint", quantityAdjusted: -10, rate: 485 },
      { name: "Carton", quantityAdjusted: -10, rate: 250 },
    ],
  };
  manufacture(data, [{ code: "labour", name: "Labour & Wages Exp." }]);
  assert.deepStrictEqual(data.additionalCosts, [
    {
      account: "labour",
      name: "Labour & Wages Exp.",
      percent: 30,
      amount: 19005,
    },
  ]);
  assert.deepStrictEqual(
    [
      data.lines[0].costPercent,
      data.lines[0].costPrice,
      data.lines[1].costPrice,
    ],
    [98, 8070.79, 16.47],
  );
});
