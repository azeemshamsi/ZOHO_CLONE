// Separate COD and prepaid accounts with one courier (Blue Dart): each order goes to the right one.
const test = require("node:test");
const assert = require("node:assert");
const CourierAccount = require("../src/models/CourierAccount");
const prepaid = {
  _id: "p1",
  organization: "o",
  carrier: "bluedart",
  name: "Blue Dart Prepaid",
  active: true,
  options: { codEnabled: false },
};
const cod = {
  _id: "c1",
  organization: "o",
  carrier: "bluedart",
  name: "Blue Dart COD",
  active: true,
  options: { codOnly: true },
};
CourierAccount.find = async () => [prepaid, cod];
const SH = require("../src/utils/shopify/ship");
const order = (mode, codAmount) => ({
  paymentMode: mode,
  codAmount,
  total: 1000,
  lines: [],
});

test("COD order on the prepaid account → the COD account; prepaid on the COD account → prepaid", async () => {
  assert.strictEqual(
    (await SH.accountForPayment(prepaid, order("cod", 1000))).name,
    "Blue Dart COD",
  );
  assert.strictEqual(
    (await SH.accountForPayment(cod, order("prepaid", 0))).name,
    "Blue Dart Prepaid",
  );
  assert.strictEqual(
    (await SH.accountForPayment(cod, order("partial", 400))).name,
    "Blue Dart COD",
  );
  assert.strictEqual(
    (await SH.accountForPayment(prepaid, order("prepaid", 0))).name,
    "Blue Dart Prepaid",
  );
});

test("no matching account: a clear error", async () => {
  CourierAccount.find = async () => [prepaid];
  await assert.rejects(
    SH.accountForPayment(prepaid, order("cod", 500)),
    /no Blue Dart account for COD orders/,
  );
});
