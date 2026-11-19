// Cancel a booked shipment: courier cancel, Shopify fulfilment cancelled (by AWB, else the untracked one),
// order back to Packed; courier refusal stops unless forced.
const test = require("node:test");
const assert = require("node:assert");
const client = require("../src/utils/shopify/client");
const calls = [];
let fulfillments = [];
client.gql = async (store, q, v) => {
  calls.push({ q, v });
  if (q.includes("fulfillments(first")) return { order: { fulfillments } };
  if (q.includes("fulfillmentCancel")) return { fulfillmentCancel: { fulfillment: { id: v.id, status: "CANCELLED" }, userErrors: [] } };
  throw new Error("unexpected");
};
const ShopifyStore = require("../src/models/ShopifyStore");
const CourierAccount = require("../src/models/CourierAccount");
ShopifyStore.findOne = async () => ({ shop: "x" });
let refuse = false;
CourierAccount.findById = async () => ({ name: "Blue Dart", carrier: "bluedart" });
const { CARRIERS } = require("../src/utils/couriers");
CARRIERS.bluedart.cancel = async () => {
  if (refuse) throw new Error("AWB already manifested");
};
const { cancelShipment } = require("../src/utils/shopify/ship");
const order = () => ({ name: "#1", status: "ready_to_ship", shopifyId: "gid://shopify/Order/1", shipment: { awb: "509", courierName: "Blue Dart", account: "a", carrier: "bluedart" }, remarks: "", save: async function () {} });

test("cancels with the courier and the Shopify fulfilment with that AWB", async () => {
  fulfillments = [{ id: "F1", status: "SUCCESS", trackingInfo: [{ number: "509" }] }, { id: "F2", status: "SUCCESS", trackingInfo: [{ number: "777" }] }];
  calls.length = 0;
  const o = order();
  const r = await cancelShipment(o);
  assert.strictEqual(r.shopify, "Shopify fulfilment cancelled");
  assert.deepStrictEqual(calls.filter((c) => c.q.includes("fulfillmentCancel")).map((c) => c.v.id), ["F1"]);
  assert.strictEqual(o.status, "packed");
  assert.strictEqual(o.cancelledShipments[0].awb, "509");
});

test("no fulfilment with the AWB: the untracked one is cancelled", async () => {
  fulfillments = [{ id: "F3", status: "SUCCESS", trackingInfo: [] }];
  calls.length = 0;
  await cancelShipment(order());
  assert.deepStrictEqual(calls.filter((c) => c.q.includes("fulfillmentCancel")).map((c) => c.v.id), ["F3"]);
});

test("courier refuses: stops, unless forced", async () => {
  refuse = true;
  fulfillments = [{ id: "F1", status: "SUCCESS", trackingInfo: [{ number: "509" }] }];
  await assert.rejects(cancelShipment(order()), (e) => e.courierRefused && /already manifested/.test(e.message));
  const o = order();
  const r = await cancelShipment(o, { force: true });
  assert.match(r.courier, /not cancelled with Blue Dart/);
  assert.strictEqual(o.status, "packed");
  refuse = false;
});
