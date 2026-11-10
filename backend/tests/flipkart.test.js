const test = require("node:test");
const assert = require("node:assert");
const { normalise } = require("../src/utils/flipkart/orders");

test("Flipkart shipment → order: lines, totals, state, self-ship", () => {
  const s = {
    shipmentId: "SH1",
    locationId: "LOC1",
    dispatchByDate: "2026-11-12T10:00:00Z",
    orderItems: [
      { orderItemId: "OI1", orderId: "OD100", sku: "AFR1", fsn: "FSN1234567890", quantity: 2, status: "APPROVED", orderDate: "2026-11-10T05:00:00Z", paymentType: "COD", priceComponents: { sellingPrice: 1900, totalPrice: 2000, shippingCharge: 100 } },
      { orderItemId: "OI2", orderId: "OD100", sku: "AFR2", quantity: 1, status: "CANCELLED", priceComponents: { totalPrice: 500 } },
    ],
    shipmentType: "SELF_SHIP",
  };
  const n = normalise(s, { deliveryAddress: { firstName: "Asha", lastName: "K", addressLine1: "12 MG Road", city: "Pune", stateName: "Maharashtra", pincode: 411001, contactNumber: "9999999999" } }, { _id: "acc" });
  assert.equal(n.name, "OD100");
  assert.equal(n.lines.length, 1);
  assert.equal(n.lines[0].unitPrice, 950);
  assert.equal(n.total, 2000);
  assert.equal(n.paymentMode, "cod");
  assert.equal(n.flipkart.state, "APPROVED");
  assert.equal(n.flipkart.selfShip, true);
  assert.equal(n.shippingAddress.zip, "411001");
  assert.equal(n.customer.name, "Asha K");
});
