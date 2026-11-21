// A seller already shipped part of the order (fulfilled in Shopify): our booking covers only the rest —
// the remaining products, their share of the COD, fulfilled in Shopify by line.
const test = require("node:test");
const assert = require("node:assert");
const client = require("../src/utils/shopify/client");
let unfulfilled = { LA: 3, LB: 0 };
const gqlCalls = [];
client.gql = async (store, q, v) => {
  gqlCalls.push({ q, v });
  if (q.includes("unfulfilledQuantity"))
    return {
      order: {
        lineItems: {
          nodes: Object.entries(unfulfilled).map(([id, n]) => ({
            id,
            unfulfilledQuantity: n,
          })),
        },
      },
    };
  if (q.includes("fulfillmentOrders"))
    return {
      order: {
        fulfillmentOrders: {
          nodes: [
            {
              id: "FO1",
              status: "OPEN",
              lineItems: {
                nodes: [
                  { id: "FOL-A", remainingQuantity: 3, lineItem: { id: "LA" } },
                  { id: "FOL-B", remainingQuantity: 1, lineItem: { id: "LB" } },
                ],
              },
            },
          ],
        },
      },
    };
  if (q.includes("fulfillmentCreate"))
    return { fulfillmentCreate: { fulfillment: { id: "F" }, userErrors: [] } };
  throw new Error("unexpected " + q.slice(0, 40));
};
const { CARRIERS } = require("../src/utils/couriers");
const booked = [];
CARRIERS.custom.book = async (acc, s) => (
  booked.push(s),
  { awb: `AWB${booked.length}`, courierName: "Test" }
);
require("../src/utils/couriers/rates").quoteAccount = async () => ({
  serviceable: true,
  charge: 100,
  source: "api",
});
require("../src/utils/shopify/package").resolvePackage = async () => ({
  weight: 2,
  length: 30,
  breadth: 20,
  height: 10,
});
const acc = {
  _id: "a1",
  name: "Test",
  carrier: "custom",
  options: {},
  pickup: {},
  active: true,
};
require("../src/models/CourierAccount").findOne = async () => acc;
require("../src/models/ShopifyStore").findOne = async () => ({
  connected: true,
  fulfillInShopify: true,
  notifyCustomer: false,
});
require("../src/models/Organization").findById = async () => ({
  name: "Shiraz",
  address: {},
});
require("../src/models/Item").find = () => ({ lean: async () => [] });
require("../src/utils/sellers").pickupFor = async () => null;
const SH = require("../src/utils/shopify/ship");

const order = () => ({
  name: "#200962",
  status: "new",
  channel: "shopify",
  shopifyId: "gid://shopify/Order/9",
  paymentMode: "cod",
  codAmount: 1000,
  total: 1000,
  orderDate: new Date(),
  lines: [
    { lineId: "LA", title: "Shelf", quantity: 3, total: 600, sku: "A" },
    {
      lineId: "LB",
      title: "Armillary",
      quantity: 1,
      total: 400,
      sku: "wave-10",
    },
  ],
  shippingAddress: {
    name: "R",
    address1: "x",
    city: "Pune",
    zip: "411001",
    phone: "9999999999",
  },
  customer: {},
  markModified() {},
  save: async function () {},
});

test("remaining() leaves out units fulfilled elsewhere", () => {
  const r = SH.remaining(order(), new Map(Object.entries({ LA: 3, LB: 0 })));
  assert.deepStrictEqual(
    r.rows.map((x) => [x.line.lineId, x.quantity]),
    [["LA", 3]],
  );
  assert.deepStrictEqual(r.done, [
    { lineId: "LB", title: "Armillary", sku: "wave-10", quantity: 1 },
  ]);
  assert.strictEqual(
    SH.shippableView(
      order(),
      new Map([
        ["LA", 3],
        ["LB", 1],
      ]),
    ).lines.length,
    2,
  ); // nothing done: whole order
  const v = SH.shippableView(
    order(),
    new Map([
      ["LA", 3],
      ["LB", 0],
    ]),
  );
  assert.deepStrictEqual([v.lines.length, v.total, v.codAmount], [1, 600, 600]);
});

test("booking ships only the seller-less remainder, with its share of the COD", async () => {
  const o = order();
  gqlCalls.length = 0;
  const r = await SH.bookOrder({ org: "o", storeOrg: "o" }, o, {
    accountId: "a1",
  });
  assert.strictEqual(r.awb, "AWB1");
  assert.strictEqual(booked[0].codAmount, 600);
  assert.strictEqual(o.shipment.codAmount, 600);
  assert.deepStrictEqual(
    o.shipment.lines.map((l) => [l.lineId, l.quantity]),
    [["LA", 3]],
  );
  assert.strictEqual(o.extraShipments, undefined);
  const fc = gqlCalls.find((c) => c.q.includes("fulfillmentCreate"));
  assert.deepStrictEqual(
    fc.v.f.lineItemsByFulfillmentOrder[0].fulfillmentOrderLineItems,
    [{ id: "FOL-A", quantity: 3 }],
  );
});

test("boxes can't include an already-fulfilled product; nothing left → clear error", async () => {
  await assert.rejects(
    SH.bookOrder({ org: "o", storeOrg: "o" }, order(), {
      accountId: "a1",
      boxes: [
        { lines: [{ lineId: "LA", quantity: 2 }] },
        {
          lines: [
            { lineId: "LA", quantity: 1 },
            { lineId: "LB", quantity: 1 },
          ],
        },
      ],
    }),
    /Armillary is already fulfilled in Shopify/,
  );
  unfulfilled = { LA: 0, LB: 0 };
  await assert.rejects(
    SH.bookOrder({ org: "o", storeOrg: "o" }, order(), { accountId: "a1" }),
    /already fulfilled in Shopify/,
  );
});

test("one item packed in 2 boxes: value and COD halved, fulfilled once, sizes required", async () => {
  unfulfilled = { LA: 3, LB: 1 };
  booked.length = 0;
  gqlCalls.length = 0;
  const parts = (pkg) => [
    { lines: [{ lineId: "LA", quantity: 3 }] },
    { lines: [{ lineId: "LB", quantity: 1, part: 1, of: 2 }], pkg },
    { lines: [{ lineId: "LB", quantity: 1, part: 2, of: 2 }], pkg },
  ];
  await assert.rejects(
    SH.bookOrder({ org: "o", storeOrg: "o" }, order(), {
      accountId: "a1",
      boxes: parts({}),
    }),
    /Box 2 holds part of an item/,
  );
  assert.throws(
    () =>
      SH.splitBoxes(order(), [
        { lines: [{ lineId: "LA", quantity: 3 }] },
        {
          lines: [{ lineId: "LB", quantity: 1, part: 1, of: 2 }],
          pkg: { weight: 9, length: 1, breadth: 1, height: 1 },
        },
      ]),
    /Armillary: 0.5 of 1/,
  );
  const o = order();
  const pkg = { weight: 9, length: 100, breadth: 50, height: 40 };
  const r = await SH.bookOrder({ org: "o", storeOrg: "o" }, o, {
    accountId: "a1",
    boxes: parts(pkg),
  });
  assert.strictEqual(r.boxes, 3);
  assert.deepStrictEqual(
    booked.map((s) => s.codAmount),
    [600, 200, 200],
  );
  assert.deepStrictEqual(
    o.extraShipments.map((x) => x.lines[0].title),
    ["Armillary (part 1 of 2)", "Armillary (part 2 of 2)"],
  );
  assert.strictEqual(o.extraShipments[1].shopifyFulfilled, false); // part 2 makes no second fulfilment
  assert.strictEqual(
    gqlCalls.filter((c) => c.q.includes("fulfillmentCreate")).length,
    2,
  );
});

test("labels per box: box 1 booked before its lines/COD were kept (#201645) gets the rest", () => {
  const o = {
    name: "#201645",
    paymentMode: "cod",
    codAmount: 6196,
    total: 6196,
    lines: [
      { lineId: "A", title: "Abstract", quantity: 1, total: 2599 },
      { lineId: "B", title: "Deer", quantity: 1, total: 2199 },
      { lineId: "C", title: "Set of 3", quantity: 1, total: 1299 },
    ],
    shipment: { awb: "3100110450811" },
    extraShipments: [
      {
        awb: "3100110450822",
        box: 2,
        of: 2,
        codAmount: 1320.09,
        lines: [{ lineId: "C", title: "Set of 3", quantity: 1 }],
      },
    ],
  };
  const v = SH.boxViews(o);
  assert.deepStrictEqual(
    v.map((x) => [
      x.name,
      x.codAmount,
      x.paymentMode,
      x.lines.map((l) => l.lineId).join(""),
    ]),
    [
      ["#201645 box 1/2", 4875.91, "cod", "AB"],
      ["#201645 box 2/2", 1320.09, "cod", "C"],
    ],
  );
  assert.strictEqual(SH.boxViews({ ...o, extraShipments: [] }), null);
});

test("a seller's already-shipped product doesn't make the rest a mixed-pickup order (#200962)", async () => {
  unfulfilled = { LA: 3, LB: 0 };
  const sellers = require("../src/utils/sellers");
  const was = sellers.pickupFor;
  sellers.pickupFor = async (org, o) => {
    if (o.lines.some((l) => l.lineId === "LB"))
      throw new Error("has products from your own stock and WAVE_NAUTICAL");
    return null;
  };
  try {
    const o = order();
    const r = await SH.bookOrder({ org: "o", storeOrg: "o" }, o, {
      accountId: "a1",
    });
    assert.ok(r.awb);
  } finally {
    sellers.pickupFor = was;
  }
});
