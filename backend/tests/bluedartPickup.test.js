// Blue Dart: pickup registered (token) with the waybill, or by its own call when the waybill gives none.
const test = require("node:test");
const assert = require("node:assert");
const http = require("../src/utils/couriers/http");
const calls = [];
let waybillToken = "";
let denyPickup = false;
http.request = async (url, opts = {}) => {
  calls.push({ url, json: opts.json });
  if (denyPickup && url.includes("RegisterPickup")) return { status: 400, data: { status: 400, title: "Bad Request", "error-response": [{ StatusCode: "UnauthorizedUser", StatusInformation: "User not authorized to register pickup for specified Area Customer code" }] } };
  if (url.includes("GetServicesforPincode")) return { status: 200, data: { GetServicesforPincodeResult: { IsError: false, AreaCode: "JAI" } } };
  if (url.includes("GenerateWayBill")) return { status: 200, data: { GenerateWayBillResult: { AWBNo: "50942867290", TokenNumber: waybillToken, IsError: false } } };
  if (url.includes("RegisterPickup")) return { status: 200, data: { RegisterPickupResult: { IsError: false, TokenNumber: "887766" } } };
  throw new Error("unexpected " + url);
};
const { CARRIERS } = require("../src/utils/couriers");
const sellers = require("../src/utils/sellers");
const bd = CARRIERS.bluedart;
const acc = () => ({ _id: "a1", carrier: "bluedart", token: "t", tokenExpires: new Date(Date.now() + 3600000), credentials: { loginId: "L", licenceKey: "K", clientId: "c", clientSecret: "s" }, options: { customerCode: "123", originArea: "DEL" }, pickup: { name: "Own", address: "Our godown", pincode: "110001", phone: "9999999999" }, save: async () => {} });
const shipment = { consignee: { name: "Jayshree", address1: "a", city: "Pune", pincode: "411001", phone: "9096368883", email: "" }, seller: { name: "Shiraz" }, weight: 5, length: 10, breadth: 10, height: 10, value: 13425, cod: false, codAmount: 0, reference: "#201265", description: "Bar cart", items: [] };

test("no token from the waybill → pickup registered separately at the seller's address", async () => {
  calls.length = 0;
  const seller = { _id: "s1", name: "N.R.HOMESDECOR", pickup: { name: "NR", address: "Jaipur road", pincode: "302001", phone: "9888888888" }, couriers: {} };
  const out = await bd.book(sellers.withPickup(acc(), seller), shipment);
  assert.strictEqual(out.refs.token, "887766");
  assert.strictEqual(out.refs.area, "DEL");
  const wb = calls.find((c) => c.url.includes("GenerateWayBill")).json.Request;
  assert.strictEqual(wb.Shipper.OriginArea, "DEL");
  assert.strictEqual(wb.Services.RegisterPickup, true);
  const rp = calls.find((c) => c.url.includes("RegisterPickup")).json.request;
  assert.deepStrictEqual(rp.AWBNo, ["50942867290"]);
  assert.strictEqual(rp.CustomerPincode, "302001");
  assert.strictEqual(rp.AreaCode, "DEL");
});

test("area / customer code mismatch gives a plain reason", async () => {
  denyPickup = true;
  const seller = { _id: "s1", name: "NR", pickup: { name: "NR", address: "x", pincode: "302001", phone: "9888888888" }, couriers: {} };
  await assert.rejects(bd.registerPickup(sellers.withPickup(acc(), seller), { awb: "1", area: "DEL", weight: 1 }), /Ask Blue Dart for a customer code and area code for this seller/);
  denyPickup = false;
});

test("token from the waybill is kept; own pickup keeps the account's area", async () => {
  calls.length = 0;
  waybillToken = "5544";
  const out = await bd.book(acc(), shipment);
  assert.strictEqual(out.refs.token, "5544");
  assert.ok(!calls.some((c) => c.url.includes("RegisterPickup") || c.url.includes("GetServicesforPincode")));
  assert.strictEqual(out.refs.area, "DEL");
});

test("pickup switched off: no registration", async () => {
  calls.length = 0;
  waybillToken = "";
  const a = acc();
  a.options.autoPickup = false;
  const out = await bd.book(a, shipment);
  assert.ok(!out.refs.token && !calls.some((c) => c.url.includes("RegisterPickup")));
});
