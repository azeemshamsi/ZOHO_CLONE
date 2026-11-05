const test = require("node:test");
const assert = require("node:assert");
const { monthRange, prevMonth, linePurchase, lineValue, withPickup, pickupProblems } = require("../src/utils/sellers");

test("month range is the month in India", () => {
  const r = monthRange("2026-10");
  assert.equal(r.from.toISOString(), "2026-09-30T18:30:00.000Z");
  assert.equal(r.to.toISOString(), "2026-10-31T18:29:59.999Z");
});
test("previous month, across the year end, in IST", () => {
  assert.equal(prevMonth(new Date("2026-11-05T06:00:00Z")), "2026-10");
  assert.equal(prevMonth(new Date("2027-01-05T06:00:00Z")), "2026-12");
  assert.equal(prevMonth(new Date("2026-11-30T19:00:00Z")), "2026-11"); // already 1 Dec in India
});
test("purchase = rate% of the sale price incl. GST, before discount", () => {
  const l = { unitPrice: 1180, quantity: 2, discount: 200, total: 2160 };
  assert.equal(lineValue(l), 2360);
  assert.equal(linePurchase({ rate: 60 }, l), 1416);
  assert.equal(linePurchase({ rate: 62.5 }, { unitPrice: 999, quantity: 1 }), 624.38);
});
test("courier account seen with the seller's pickup; writes go to the real account", () => {
  const acc = { _id: "a1", carrier: "delhivery", options: { pickupLocation: "Main WH", shippingMode: "Surface" }, pickup: { pincode: "201301" }, token: "" };
  const seller = { name: "Brass Hub", phone: "9876543210", pickup: { address: "12 Industrial Area, Phase 2", city: "Moradabad", state: "09", pincode: "244001" }, couriers: { a1: { pickupLocation: "Brass Hub 244001" } } };
  const v = withPickup(acc, seller);
  assert.equal(v.pickup.pincode, "244001");
  assert.equal(v.pickup.name, "Brass Hub");
  assert.equal(v.options.pickupLocation, "Brass Hub 244001");
  assert.equal(v.options.shippingMode, "Surface");
  v.token = "abc";
  assert.equal(acc.token, "abc");
  assert.equal(acc.pickup.pincode, "201301");
  assert.equal(acc.options.pickupLocation, "Main WH");
  assert.equal(withPickup(acc, null), acc);
});
test("pickup address checks", () => {
  assert.deepEqual(pickupProblems({ phone: "9876543210", pickup: { address: "12 Industrial Area", city: "X", state: "09", pincode: "244001" } }), []);
  assert.deepEqual(pickupProblems({ pickup: { address: "x" } }), ["address", "6-digit pincode", "phone", "city", "state"]);
});
