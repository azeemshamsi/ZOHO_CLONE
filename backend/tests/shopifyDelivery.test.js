const test = require("node:test");
const assert = require("node:assert");
const { deliveryOf, applyDelivery } = require("../src/utils/shopify/sync");

// #199536: delivered by Delhivery; an earlier Blue Dart fulfilment was cancelled.
const o199536 = { fulfillments: [
  { status: "SUCCESS", displayStatus: "DELIVERED", deliveredAt: "2026-10-19T13:07:33Z" },
  { status: "CANCELLED", displayStatus: "CANCELED", deliveredAt: null },
] };

test("cancelled fulfilments are ignored; all delivered → delivered", () => {
  const d = deliveryOf(o199536);
  assert.equal(d.status, "delivered");
  assert.equal(d.at.toISOString(), "2026-10-19T13:07:33.000Z");
});
test("partly delivered is not delivered", () => {
  assert.equal(deliveryOf({ fulfillments: [{ status: "SUCCESS", displayStatus: "DELIVERED" }, { status: "SUCCESS", displayStatus: "IN_TRANSIT" }] }).status, "in_transit");
  assert.equal(deliveryOf({ fulfillments: [] }), null);
});
test("a shipped order becomes delivered with Shopify's delivery date", () => {
  const o = { status: "shipped", shipment: { carrier: "shopify", awb: "x" }, markModified() {} };
  assert.equal(applyDelivery(o, deliveryOf(o199536)), true);
  assert.equal(o.status, "delivered");
  assert.equal(o.deliveredAt.toISOString(), "2026-10-19T13:07:33.000Z");
  assert.equal(o.shipment.trackStatus, "delivered");
});
test("other statuses are left alone", () => {
  for (const status of ["new", "ready_to_ship", "rto", "return_created", "cancelled"]) {
    const o = { status, shipment: {}, markModified() {} };
    assert.equal(applyDelivery(o, { status: "delivered", at: new Date() }), false);
    assert.equal(o.status, status);
  }
});

test("courier statuses: booked / awaiting pickup stay Ready to Ship; a pickup or transit scan means Shipped", () => {
  const { normStatus, handedOver } = require("../src/utils/couriers");
  for (const t of ["Manifested", "Not Picked", "PICKUP SCHEDULED", "OUT FOR PICKUP", "AWB ASSIGNED", "Booked", "new", "assigned_for_pickup", "Softdata Upload", "Something unknown"]) assert.equal(normStatus(t), "pending", t);
  for (const t of ["In Transit", "Picked Up", "Shipment Picked Up", "Dispatched", "Manifested at Hub", "Received at origin"]) assert.equal(normStatus(t), "in_transit", t);
  assert.equal(normStatus("Out For Delivery"), "out_for_delivery");
  assert.equal(handedOver([{ status: "Manifested" }, { status: "Shipment Picked Up" }]), true);
  assert.equal(handedOver([{ status: "Manifested" }, { status: "Not Picked" }]), false);
});

test("Shopify returns: requested → Returns; declined → back to Delivered; closed → to be closed (Returned)", async () => {
  const ShopifyOrder = require("../src/models/ShopifyOrder");
  const { upsert } = require("../src/utils/shopify/sync");
  const doc = new ShopifyOrder({ organization: "64b000000000000000000001", shopifyId: "gid://shopify/Order/1", name: "#1", status: "delivered", deliveredAt: new Date(), returnStatus: "NO_RETURN", shopifyUpdatedAt: new Date(0) });
  doc.save = async () => doc;
  const orig = ShopifyOrder.findOne;
  ShopifyOrder.findOne = async () => doc;
  let t = 1;
  const n = (returnStatus) => ({ shopifyId: "gid://shopify/Order/1", returnStatus, shopifyUpdatedAt: new Date(t++ * 1000), shopifyFulfillments: [], fulfillmentStatus: "FULFILLED" });
  try {
    await upsert(doc.organization, n("RETURN_REQUESTED"));
    assert.equal(doc.status, "return_created");
    await upsert(doc.organization, n("NO_RETURN"));
    assert.equal(doc.status, "delivered", "declined: back to Delivered");
    await upsert(doc.organization, n("RETURN_REQUESTED"));
    await upsert(doc.organization, n("IN_PROGRESS"));
    const toClose = [];
    await upsert(doc.organization, n("RETURNED"), toClose);
    assert.deepEqual(toClose.map(String), [String(doc._id)], "closed in Shopify: closed here too");
    // A return made in OrdexaGo that Shopify never had isn't undone by NO_RETURN.
    doc.status = "return_created";
    doc.returnStatus = "NO_RETURN";
    doc.shopifyReturnId = undefined;
    await upsert(doc.organization, n("NO_RETURN"));
    assert.equal(doc.status, "return_created");
  } finally {
    ShopifyOrder.findOne = orig;
  }
});

test("orders still in Returns are checked against Shopify: declined → Delivered, closed → closed, none in Shopify → left", async () => {
  const ShopifyOrder = require("../src/models/ShopifyOrder");
  const client = require("../src/utils/shopify/client");
  const mk = (id, extra = {}) => Object.assign(new ShopifyOrder({ organization: "64b000000000000000000001", shopifyId: `gid://shopify/Order/${id}`, name: `#${id}`, status: "return_created", deliveredAt: new Date(), ...extra }), { save: async function () { return this; } });
  const docs = [mk(1), mk(2), mk(3), mk(4, { returnFrom: "shipped", deliveredAt: undefined })];
  const origFind = ShopifyOrder.find;
  const origGql = client.gql;
  ShopifyOrder.find = async () => docs;
  const R = { 1: ["DECLINED"], 2: ["CLOSED"], 3: [], 4: ["CANCELED", "DECLINED"] };
  client.gql = async (store, q, v) => ({ nodes: v.ids.map((id) => ({ id, returns: { nodes: R[id.split("/").pop()].map((status) => ({ status })) } })) });
  delete require.cache[require.resolve("../src/utils/shopify/sync")];
  try {
    const { reconcileReturns } = require("../src/utils/shopify/sync");
    const toClose = [];
    const n = await reconcileReturns({ organization: "x" }, toClose);
    assert.equal(n, 2);
    assert.deepEqual(docs.map((d) => d.status), ["delivered", "return_created", "return_created", "shipped"]);
    assert.deepEqual(toClose.map(String), [String(docs[1]._id)]);
  } finally {
    ShopifyOrder.find = origFind;
    client.gql = origGql;
    delete require.cache[require.resolve("../src/utils/shopify/sync")];
  }
});
