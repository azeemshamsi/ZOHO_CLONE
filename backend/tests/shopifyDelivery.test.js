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
