// Several boxes: split validation, COD shared by value, each box booked with its own AWB and fulfilled in
// Shopify with only its products; tracking needs every box delivered; cancel takes all boxes.
const test = require("node:test");
const assert = require("node:assert");
const client = require("../src/utils/shopify/client");
const gqlCalls = [];
client.gql = async (store, q, v) => {
  gqlCalls.push({ q, v });
  if (q.includes("fulfillmentOrders")) return { order: { fulfillmentOrders: { nodes: [{ id: "FO1", status: "OPEN", lineItems: { nodes: [{ id: "FOL-A", remainingQuantity: 3, lineItem: { id: "LA" } }, { id: "FOL-B", remainingQuantity: 2, lineItem: { id: "LB" } }] } }] } } };
  if (q.includes("fulfillmentCreate")) return { fulfillmentCreate: { fulfillment: { id: "F" }, userErrors: [] } };
  if (q.includes("fulfillments(first")) return { order: { fulfillments: [] } };
  throw new Error("unexpected " + q.slice(0, 40));
};
const { CARRIERS } = require("../src/utils/couriers");
let n = 0;
const booked = [];
CARRIERS.custom.book = async (acc, s, manual) => {
  booked.push(s);
  return { awb: manual.awb || `AWB${++n}`, courierName: "Test" };
};
CARRIERS.custom.cancel = async () => {};
const statuses = {};
CARRIERS.custom.track = async (acc, sh) => ({ status: statuses[sh.awb] || "pending", events: [] });
const rates = require("../src/utils/couriers/rates");
rates.quoteAccount = async () => ({ serviceable: true, charge: 100, source: "api" });
const pkgMod = require("../src/utils/shopify/package");
pkgMod.resolvePackage = async (o, pkg) => ({ weight: pkg.weight || 2, length: 30, breadth: 20, height: 10 });
const CourierAccount = require("../src/models/CourierAccount");
const acc = { _id: "a1", name: "Test", carrier: "custom", options: {}, pickup: {}, active: true };
CourierAccount.findOne = async () => acc;
CourierAccount.findById = async () => acc;
const ShopifyStore = require("../src/models/ShopifyStore");
ShopifyStore.findOne = async () => ({ fulfillInShopify: true, notifyCustomer: false });
require("../src/models/Organization").findById = async () => ({ name: "Shiraz", address: {} });
require("../src/models/Item").find = () => ({ lean: async () => [] });
require("../src/utils/sellers").pickupFor = async () => null;
const SH = require("../src/utils/shopify/ship");

const order = () => ({
  name: "#300",
  status: "new",
  channel: "shopify",
  shopifyId: "gid://shopify/Order/9",
  paymentMode: "cod",
  codAmount: 1000,
  total: 1000,
  orderDate: new Date(),
  lines: [
    { lineId: "LA", title: "Shelf", quantity: 3, total: 600, sku: "A" },
    { lineId: "LB", title: "Lamp", quantity: 2, total: 400, sku: "B" },
  ],
  shippingAddress: { name: "R", address1: "x", city: "Pune", zip: "411001", phone: "9999999999" },
  customer: {},
  markModified() {},
  save: async function () {},
});

test("split must place every unit exactly once", () => {
  assert.throws(() => SH.splitBoxes(order(), [{ lines: [{ lineId: "LA", quantity: 2 }] }, { lines: [{ lineId: "LB", quantity: 2 }] }]), /Shelf: 2 of 3/);
  assert.strictEqual(SH.splitBoxes(order(), [{ lines: [{ lineId: "LA", quantity: 3 }, { lineId: "LB", quantity: 2 }] }]), null);
});

test("3 boxes: own AWBs, COD by value, Shopify fulfilment per box", async () => {
  const o = order();
  gqlCalls.length = 0;
  const r = await SH.bookOrder({ org: "o", storeOrg: "o" }, o, {
    accountId: "a1",
    boxes: [
      { lines: [{ lineId: "LA", quantity: 2 }] },
      { lines: [{ lineId: "LA", quantity: 1 }, { lineId: "LB", quantity: 1 }] },
      { lines: [{ lineId: "LB", quantity: 1 }], pkg: { weight: 5 } },
    ],
  });
  assert.strictEqual(r.boxes, 3);
  assert.strictEqual(o.shipment.awb, "AWB1");
  assert.deepStrictEqual(o.extraShipments.map((x) => [x.box, x.awb, x.codAmount]), [[2, "AWB2", 400], [3, "AWB3", 200]]);
  assert.strictEqual(o.shipment.codAmount, 400);
  assert.deepStrictEqual(booked.map((s) => s.reference), ["300", "300-B2", "300-B3"]);
  assert.strictEqual(booked[2].weight, 5);
  const fc = gqlCalls.filter((c) => c.q.includes("fulfillmentCreate")).map((c) => c.v.f.lineItemsByFulfillmentOrder[0].fulfillmentOrderLineItems);
  assert.deepStrictEqual(fc, [[{ id: "FOL-A", quantity: 2 }], [{ id: "FOL-A", quantity: 1 }, { id: "FOL-B", quantity: 1 }], [{ id: "FOL-B", quantity: 1 }]]);
  assert.strictEqual(o.status, "ready_to_ship");

  // tracking: delivered only when every box is
  statuses.AWB1 = "delivered";
  statuses.AWB2 = "delivered";
  statuses.AWB3 = "in_transit";
  await SH.trackOrder(o);
  assert.strictEqual(o.status, "shipped");
  statuses.AWB3 = "delivered";
  await SH.trackOrder(o);
  assert.strictEqual(o.status, "delivered");
});

test("cancel takes every box", async () => {
  const o = order();
  booked.length = 0;
  await SH.bookOrder({ org: "o", storeOrg: "o" }, o, { accountId: "a1", boxes: [{ lines: [{ lineId: "LA", quantity: 3 }] }, { lines: [{ lineId: "LB", quantity: 2 }] }] });
  const awbs = [o.shipment.awb, o.extraShipments[0].awb];
  await SH.cancelShipment(o);
  assert.deepStrictEqual(o.cancelledShipments.map((x) => x.awb), awbs);
  assert.strictEqual(o.extraShipments, undefined);
  assert.strictEqual(o.status, "packed");
});

test("booked in parts: Shelf now with one courier, Lamp later with another; COD by value; shipments add up", async () => {
  const o = order();
  booked.length = 0;
  const r1 = await SH.bookOrder({ org: "o" }, o, { accountId: "a1", boxes: [{ lines: [{ lineId: "LA", quantity: 3 }] }], leaveRest: true });
  assert.strictEqual(r1.restLeft, true);
  assert.strictEqual(o.partBooked, true);
  assert.strictEqual(booked[0].codAmount, 600); // the Shelf's share of the ₹1000 COD
  assert.deepStrictEqual(o.shipment.lines.map((l) => [l.lineId, l.quantity]), [["LA", 3]]);
  // the rest: only the Lamp is left, with another courier
  assert.deepStrictEqual([...SH.availOf(o, null)].map(([k, v]) => [k, v]), [["LA", 0], ["LB", 2]]);
  o.status = "ready_to_ship";
  const r2 = await SH.bookOrder({ org: "o" }, o, { accountId: "a1" });
  assert.ok(!r2.restLeft);
  assert.ok(!o.partBooked);
  assert.strictEqual(booked[1].codAmount, 400);
  assert.deepStrictEqual(SH.allShipments(o).map((x) => [x.box, x.lines.map((l) => l.lineId).join()]), [[1, "LA"], [2, "LB"]]);
  // nothing left now
  o.partBooked = true;
  await assert.rejects(SH.bookOrder({ org: "o" }, o, { accountId: "a1" }), /already booked/);
});
