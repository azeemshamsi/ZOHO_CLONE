const test = require("node:test");
const assert = require("node:assert");
const { rateCardCharge, zoneOf, chargeableWeight } = require("../src/utils/couriers/rates");

const card = { enabled: true, slab: 0.5, divisor: 5000, codFixed: 40, codPercent: 2, fuelPercent: 10, gstPercent: 18, zones: { local: { first: 30, extra: 25 }, state: { first: 40, extra: 35 }, metro: { first: 50, extra: 45 }, roi: { first: 60, extra: 55 }, special: { first: 90, extra: 80 } } };
const delhi = { pincode: "110020", city: "New Delhi", state: "07" };

test("zones", () => {
  assert.equal(zoneOf(delhi, { pincode: "110045", city: "Delhi", state: "07" }), "local");
  assert.equal(zoneOf(delhi, { pincode: "400001", city: "Mumbai", state: "27" }), "metro");
  assert.equal(zoneOf(delhi, { pincode: "302001", city: "Jaipur", state: "08" }), "roi");
  assert.equal(zoneOf(delhi, { pincode: "781001", city: "Guwahati", state: "18" }), "special");
  assert.equal(zoneOf({ pincode: "201301", city: "Noida", state: "09" }, { pincode: "226001", city: "Lucknow", state: "09" }), "state");
});

test("volumetric weight wins and rounds up to the slab", () => {
  const w = chargeableWeight({ weight: 0.4, length: 30, breadth: 20, height: 10 }, card); // 6000/5000 = 1.2 kg
  assert.equal(w.weight, 1.5);
});

test("rate card charge: freight + fuel + COD + GST", () => {
  const r = rateCardCharge({ rateCard: card }, { weight: 1.2, length: 10, breadth: 10, height: 10, cod: true, codAmount: 3000 }, delhi, { pincode: "302001", city: "Jaipur", state: "08" });
  // 1.5 kg ROI: 60 + 2×55 = 170; fuel 17; COD max(40, 60) = 60; 247 + 18% = 291.46
  assert.equal(r.freight, 170);
  assert.equal(r.cod, 60);
  assert.equal(r.total, 291.46);
});
