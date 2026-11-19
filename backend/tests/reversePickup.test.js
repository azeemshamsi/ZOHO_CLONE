// Reverse pickup: carriers get the customer as the pickup and you / the seller as the destination; booking
// records order.reverse and marks the return created; cancel keeps a history.
const test = require("node:test");
const assert = require("node:assert");
const http = require("../src/utils/couriers/http");
const calls = [];
http.request = async (url, opts = {}) => {
  calls.push({ url, json: opts.json, form: opts.form });
  if (url.includes("create.json")) return { status: 200, data: { packages: [{ waybill: "DL123", status: "Success" }] } };
  if (url.includes("GenerateWayBill")) return { status: 200, data: { GenerateWayBillResult: { AWBNo: "BD9", TokenNumber: "77", IsError: false } } };
  if (url.includes("orders/create/return")) return { status: 200, data: { order_id: 5, shipment_id: 6 } };
  if (url.includes("assign/awb")) return { status: 200, data: { response: { data: { awb_code: "SR1", courier_name: "Xpressbees" } } } };
  throw new Error("unexpected " + url);
};
const { CARRIERS } = require("../src/utils/couriers");
const from = { name: "Jayshree Zanvar", address1: "52 Kasturi Shivaji Park", address2: "", city: "Kolhapur", pincode: "416001", phone: "9096368883", email: "", state: "27", stateName: "Maharashtra" };
const s = { reference: "201265-RT", orderDate: new Date(), cod: false, codAmount: 0, value: 13425, invoiceNumber: "", description: "Bar cart", items: [{ name: "Bar cart", sku: "NR057", quantity: 1, price: 13425, hsn: "9403", taxRate: 5 }], weight: 12, length: 60, breadth: 40, height: 30, consignee: from, from, seller: { name: "Shiraz", gstin: "", address: "", stateName: "Uttar Pradesh" }, reverse: true };
const acc = (carrier, extra = {}) => ({ _id: "a1", name: carrier, carrier, token: "t", tokenExpires: new Date(Date.now() + 3600000), credentials: { token: "x", loginId: "L", licenceKey: "K", email: "e", password: "p" }, options: { pickupLocation: "WH1", customerCode: "123", originArea: "SRE" }, pickup: { name: "Shiraz Godown", address: "Mehandi Sarai", city: "Saharanpur", pincode: "247001", phone: "9999999999", state: "09" }, save: async () => {}, ...extra });

test("Delhivery: Pickup mode, customer's address", async () => {
  calls.length = 0;
  const out = await CARRIERS.delhivery.reverse(acc("delhivery"), s);
  assert.strictEqual(out.awb, "DL123");
  const data = JSON.parse(decodeURIComponent(calls[0].form.replace(/^format=json&data=/, "")));
  assert.strictEqual(data.shipments[0].payment_mode, "Pickup");
  assert.strictEqual(data.shipments[0].pin, "416001");
  assert.strictEqual(data.shipments[0].return_pin, "247001");
  assert.strictEqual(data.pickup_location.name, "WH1");
});

test("Blue Dart: reverse flag, customer as shipper, godown as consignee", async () => {
  calls.length = 0;
  const out = await CARRIERS.bluedart.reverse(acc("bluedart"), s);
  assert.strictEqual(out.awb, "BD9");
  const r = calls.find((c) => c.url.includes("GenerateWayBill")).json.Request;
  assert.strictEqual(r.Services.IsReversePickup, true);
  assert.strictEqual(r.Shipper.CustomerPincode, "416001");
  assert.strictEqual(r.Consignee.ConsigneePincode, "247001");
  assert.strictEqual(r.Services.CreditReferenceNo, "201265RT");
});

test("Shiprocket: return order from the customer to the godown", async () => {
  calls.length = 0;
  const out = await CARRIERS.shiprocket.reverse(acc("shiprocket"), s);
  assert.strictEqual(out.awb, "SR1");
  const body = calls.find((c) => c.url.includes("create/return")).json;
  assert.strictEqual(body.pickup_pincode, "416001");
  assert.strictEqual(body.shipping_pincode, "247001");
  assert.strictEqual(calls.find((c) => c.url.includes("assign/awb")).json.is_return, 1);
});

test("book and cancel on the order", async () => {
  const CourierAccount = require("../src/models/CourierAccount");
  const Organization = require("../src/models/Organization");
  const Item = require("../src/models/Item");
  const ShopifyStore = require("../src/models/ShopifyStore");
  const sellers = require("../src/utils/sellers");
  CourierAccount.findOne = async () => acc("delhivery", { active: true });
  CourierAccount.findById = async () => acc("delhivery");
  Organization.findById = async () => ({ name: "Shiraz", address: {}, state: "09" });
  Item.find = () => ({ lean: async () => [] });
  ShopifyStore.findOne = async () => null;
  sellers.pickupFor = async () => null;
  CARRIERS.delhivery.cancel = async () => {};
  const RV = require("../src/utils/shopify/reverse");
  const order = { name: "#201265", status: "delivered", channel: "shopify", total: 13425, orderDate: new Date(), lines: [{ title: "Bar cart", quantity: 1, total: 13425, sku: "NR057" }], shippingAddress: { name: "Jayshree", address1: "52 Kasturi", city: "Kolhapur", zip: "416001", phone: "9096368883", state: "27", province: "Maharashtra" }, customer: {}, remarks: "", markModified() {}, save: async () => {} };
  const r = await RV.bookReverse({ org: "o", storeOrg: "o" }, order, { accountId: "64b000000000000000000001", reason: "Damaged in transit", pkg: { weight: 12, length: 60, breadth: 40, height: 30 }, by: "A" });
  assert.strictEqual(r.reverse.awb, "DL123");
  assert.strictEqual(order.status, "return_created");
  assert.strictEqual(order.returnNote, "Damaged in transit");
  await assert.rejects(RV.bookReverse({ org: "o", storeOrg: "o" }, order, { accountId: "64b000000000000000000001" }), /already booked/);
  await RV.cancelReverse(order);
  assert.strictEqual(order.reverse.cancelled[0].awb, "DL123");
  assert.ok(!order.reverse.awb);
});
