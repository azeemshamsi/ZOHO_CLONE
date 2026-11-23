const test = require("node:test");
const assert = require("node:assert");
const http = require("../src/utils/couriers/http");

const calls = [];
http.request = async (url, opts = {}) => {
  calls.push({ url, opts });
  const ok = (data) => ({ status: 200, data: { status: true, message: "ok", status_code: 200, data } });
  if (url.endsWith("/login")) return ok({ token: "TOK" });
  if (url.endsWith("/create-order")) return ok({ CustomGlobalOrderId: "311276742" });
  if (url.endsWith("/courier-wise-shipment-cost"))
    return ok({ segment_type: "domestic_b2c", calculatedRates: [{ courierId: "25", courierName: "Delhivery", total: "180.50" }, { courierId: "7", courierName: "Xpressbees", total: "150.00" }] });
  if (url.endsWith("/place-order")) return ok({ reference_number: "R1", awb_assigned: "1490812345" });
  if (url.includes("/track-order?"))
    return ok({ order_status: "In Transit", tracking_histories: [{ order_status: "Picked Up", checkpoint_time: "2026-11-24 10:00:00", message: "Picked" }] });
  if (url.includes("/user-rate-calculator"))
    return ok([{ courier_partner_id: 7, courierName: "Xpressbees", totalCharge: 150, tat: "4", restricted_pincode_message: null }, { courier_partner_id: 9, courierName: "Blocked", totalCharge: 90, restricted_pincode_message: "ODA" }]);
  throw new Error(`unexpected ${url}`);
};
const { CARRIERS } = require("../src/utils/couriers");
const B = CARRIERS.bigship;
const acc = { _id: "b", name: "BigShip", carrier: "bigship", credentials: { username: "u", password: "p", accessKey: "k" }, options: { warehouseId: "258" }, pickup: { pincode: "247001" }, save: async () => {} };
const s = { reference: "201801", orderDate: new Date(), cod: true, codAmount: 999, value: 999, invoiceNumber: "", weight: 2, length: 30, breadth: 20, height: 10, items: [{ name: "Table", quantity: 1, price: 999, hsn: "9403" }], consignee: { name: "Ravi", phone: "9123456780", email: "", address1: "Flat 2", address2: "", city: "Pune", stateName: "Maharashtra", pincode: "411001" }, seller: { name: "Shiraz" } };

test("BigShip: order → couriers → cheapest placed → AWB", async () => {
  const out = await B.book(acc, s, {});
  assert.deepStrictEqual([out.awb, out.courierName, out.refs.orderId, out.refs.courierId], ["1490812345", "BigShip · Xpressbees", "311276742", 7]);
  const o = calls.find((c) => c.url.endsWith("/create-order")).opts;
  assert.strictEqual(o.headers.authorization, "Bearer TOK");
  assert.deepStrictEqual([o.json.MasterOrderPaymentMode, o.json.MasterOrderPickUpLocation, o.json.boxes[0].products[0].collectableAmount], [2, 258, 999]);
  const t = await B.track(acc, { awb: out.awb, refs: out.refs });
  assert.strictEqual(t.status, "in_transit");
});

test("BigShip rates: restricted pincodes left out", async () => {
  const { quoteAccount } = require("../src/utils/couriers/rates");
  const q = await quoteAccount(acc, s);
  assert.deepStrictEqual([q.serviceable, q.charge, q.options.length], [true, 150, 1]);
});
