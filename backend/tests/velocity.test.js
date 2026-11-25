const test = require("node:test");
const assert = require("node:assert");
const http = require("../src/utils/couriers/http");

const calls = [];
http.request = async (url, opts = {}) => {
  calls.push({ url, opts });
  if (url.endsWith("/reverse-order-orchestration")) return { status: 200, data: { status: 1, payload: { awb_code: "VEHR43", courier_name: "Ekart Standard", order_id: "ORDM", shipment_id: "SHIU", charges: { reverse_charges: "91.30" } } } };
  if (url.endsWith("/forward-order")) return { status: 200, data: { status: 1, payload: { order_created: 1, awb_generated: 0, shipment_id: "SHI1", order_id: "ORD1" } } };
  if (url.endsWith("/forward-order-shipment")) return { status: 200, data: { status: 1, payload: { awb_generated: 1, awb_code: "3481", courier_name: "Delhivery Standard", label_url: "https://l/v" } } };
  if (url.endsWith("/order-tracking"))
    return { status: 200, data: { result: { 3481: { tracking_data: { shipment_status: "in_transit", shipment_track_activities: [{ date: "2026-11-24 10:00:00", activity: "PICKED UP", location: "Saharanpur" }] } } } } };
  if (url.endsWith("/rates"))
    return { status: 200, data: { status: "SUCCESS", result: { serviceable_couriers: [{ carrier_id: "C2", carrier_name: "DTDC", status: "active", charges: { total_forward_charges: 150 }, platform_fee: 5 }, { carrier_id: "C1", carrier_name: "Delhivery", status: "active", charges: { total_forward_charges: 110, forward_freight_charges: 85, cod_charges: 25 }, platform_fee: 5, expected_delivery: { delivery: "2026-11-28" } }], shipment_details: { zone: "B" } } } };
  throw new Error(`unexpected ${url}`);
};
const { CARRIERS } = require("../src/utils/couriers");
const V = CARRIERS.velocity;
const acc = { _id: "v", name: "Velocity", carrier: "velocity", credentials: { apiKey: "KEY" }, options: { warehouseId: "WHYYB5", pickupLocation: "HomeNew" }, pickup: { pincode: "247001" } };
const s = { reference: "200970", orderDate: new Date("2026-11-23T10:00:00Z"), cod: true, codAmount: 990, value: 990, weight: 0.5, length: 10, breadth: 10, height: 10, items: [{ name: "Shelf", sku: "S1", quantity: 1, price: 990 }], consignee: { name: "Ravi", phone: "9123456780", email: "", address1: "Flat 2", address2: "", city: "Pune", stateName: "Maharashtra", pincode: "411001" }, seller: { name: "Shiraz" } };

test("Velocity: order, then courier → AWB and label", async () => {
  const out = await V.book(acc, s, { courierId: "C1" });
  assert.deepStrictEqual([out.awb, out.courierName, out.labelUrl], ["3481", "Delhivery Standard", "https://l/v"]);
  const o = calls.find((c) => c.url.endsWith("/forward-order")).opts;
  assert.strictEqual(o.headers.authorization, "Bearer KEY");
  assert.deepStrictEqual([o.json.payment_method, o.json.cod_collectible, o.json.warehouse_id, o.json.order_date], ["COD", 990, "WHYYB5", "2026-11-23 15:30"]);
  assert.deepStrictEqual(calls.find((c) => c.url.endsWith("/forward-order-shipment")).opts.json, { shipment_id: "SHI1", carrier_id: "C1" });
  const t = await V.track(acc, { awb: "3481" });
  assert.strictEqual(t.status, "in_transit");
  assert.strictEqual(t.events[0].location, "Saharanpur");
});

test("Velocity rates: cheapest courier first, weight sent in grams", async () => {
  const { quoteAccount } = require("../src/utils/couriers/rates");
  const q = await quoteAccount(acc, s);
  assert.deepStrictEqual([q.serviceable, q.charge, q.courierId], [true, 115, "C1"]);
  assert.strictEqual(calls.find((c) => c.url.endsWith("/rates")).opts.json.dead_weight, 500);
});

test("Velocity: reverse pickup from the customer back to the warehouse", async () => {
  const back = { ...acc, options: { ...acc.options, returnWarehouseId: "RET1" }, pickup: { name: "Shiraz", phone: "+91 98765 43210", address: "Main Rd", city: "Saharanpur", state: "Uttar Pradesh", pincode: "247001" } };
  const out = await V.reverse(back, { ...s, from: s.consignee, reference: "200970-RT", cod: false });
  assert.deepStrictEqual([out.awb, out.courierName, out.refs.charge], ["VEHR43", "Ekart Standard", "91.30"]);
  const j = calls.find((c) => c.url.endsWith("/reverse-order-orchestration")).opts.json;
  assert.deepStrictEqual([j.pickup_pincode, j.shipping_pincode, j.warehouse_id, j.payment_method, j.shipping_phone, j.request_pickup], ["411001", "247001", "RET1", "PREPAID", "9876543210", true]);
});
