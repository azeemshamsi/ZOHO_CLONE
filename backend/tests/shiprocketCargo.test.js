const test = require("node:test");
const assert = require("node:assert");
const http = require("../src/utils/couriers/http");

const calls = [];
http.request = async (url, opts = {}) => {
  calls.push({ url, opts });
  if (url.endsWith("/api/token/refresh/")) return { status: 200, data: { access: "ACC" } };
  if (url.endsWith("/api/external/order_creation/"))
    return { status: 201, data: { success: true, order_id: 77, mode_id: 16, delivery_partner_id: 11, delivery_partner_name: "Delhivery", scheduled_pickup_date: "2026-11-25", carrier_list: [{ mode_id: 16, delivery_partner_id: 11, delivery_partner_name: "Delhivery" }, { mode_id: 23, delivery_partner_id: 17, delivery_partner_name: "RB Advantage" }] } };
  if (url.endsWith("/api/order_shipment_association/")) return { status: 201, data: { id: 900, waybill_no: "WB1", label_url: "https://l/1" } };
  if (url.endsWith("/api/shipment/charges/"))
    return { status: 201, data: { success: "true", "rb-surface": { id: 17, mode_id: 23, mode_name: "surface", delivery_partner: "RB Advantage", rates: 516, working: { freight: 218.4, fsc: 43.68, gst: 78.67, recipient_zone: "NORTH-1" } }, "dl-surface": { id: 11, mode_id: 16, mode_name: "surface", delivery_partner: "Delhivery", rates: "-" } } };
  throw new Error(`unexpected ${url}`);
};
const { CARRIERS } = require("../src/utils/couriers");
const C = CARRIERS.shiprocket_cargo;
const acc = () => ({
  name: "Cargo",
  credentials: { accessToken: "A", refreshToken: "R" },
  options: { clientId: "51590", senderEmail: "help@ordexago.com", warehouseName: "Shiraz WH" },
  pickup: { name: "Shiraz", phone: "9876543210", address: "1 Road", city: "Saharanpur", state: "09", pincode: "247001" },
  save: async () => {},
});
const ship = (over = {}) => ({
  reference: "200962",
  value: 12000,
  cod: true,
  codAmount: 5000,
  invoiceNumber: "INV-1",
  seller: { name: "Shiraz" },
  consignee: { name: "Ravi", phone: "9123456780", email: "", address1: "Flat 2", address2: "", city: "Pune", stateName: "Maharashtra", pincode: "411001" },
  packages: [{ weight: 12, length: 50, breadth: 40, height: 30 }, { weight: 8, length: 40, breadth: 30, height: 30 }],
  ...over,
});

test("Shiprocket Cargo: one docket for all boxes, carrier from the booking box", async () => {
  calls.length = 0;
  const out = await C.book(acc(), ship(), { courierId: "17:23" });
  assert.deepStrictEqual([out.awb, out.labelUrl, out.refs.orderId, out.refs.shipmentId], ["WB1", "https://l/1", 77, 900]);
  const create = calls.find((c) => c.url.endsWith("order_creation/")).opts;
  assert.strictEqual(create.headers.authorization, "Bearer ACC");
  assert.strictEqual(create.json.client_id, 51590);
  assert.strictEqual(create.json.no_of_packages, 2);
  assert.strictEqual(create.json.approx_weight, 20);
  assert.strictEqual(create.json.source_state, "Uttar Pradesh");
  assert.strictEqual(create.json.recipient_contact_person_email, "help@ordexago.com");
  assert.deepStrictEqual([create.json.is_cod, create.json.cod_amount], [true, 5000]);
  const assoc = calls.find((c) => c.url.endsWith("order_shipment_association/")).opts.json;
  assert.deepStrictEqual([assoc.order_id, assoc.delivery_partner_id, assoc.mode_id], [77, 17, 23]);
  assert.strictEqual(assoc.pickup_date_time, "2026-11-25 11:00:00");
});

test("Shiprocket Cargo: above ₹50,000 needs an e-way bill", async () => {
  await assert.rejects(C.book(acc(), ship({ value: 60000 })), /e-way bill/);
});

test("Shiprocket Cargo rates: carriers with a rate, the first as the pick", async () => {
  const { quoteAccount } = require("../src/utils/couriers/rates");
  const a = { ...acc(), _id: "x", carrier: "shiprocket_cargo" };
  const q = await quoteAccount(a, { ...ship(), weight: 20, length: 50, breadth: 40, height: 30 });
  assert.strictEqual(q.serviceable, true);
  assert.strictEqual(q.charge, 516);
  assert.deepStrictEqual(q.options.map((o) => o.courierId), ["17:23"]);
});
