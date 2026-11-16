const test = require("node:test");
const assert = require("node:assert");
const client = require("../src/utils/shopify/client");
const calls = [];
client.gql = async (store, q, v) => {
  calls.push({ q, v });
  if (q.includes("draftOrderCreate")) return { draftOrderCreate: { draftOrder: { id: "gid://shopify/DraftOrder/1", name: "#D1", invoiceUrl: "https://x/pay", totalPriceSet: { shopMoney: { amount: "1099.00" } } }, userErrors: [] } };
  if (q.includes("draftOrderComplete")) return { draftOrderComplete: { draftOrder: { id: v.id, order: { id: "gid://shopify/Order/77", name: "#201" } }, userErrors: [] } };
  if (q.includes("orderCreateManualPayment")) return { orderCreateManualPayment: { order: { id: v.id }, userErrors: [] } };
  if (q.includes("order(id")) return { order: null };
  throw new Error("unexpected");
};
const CO = require("../src/utils/shopify/createOrder");

test("province and phone", () => {
  assert.strictEqual(CO.provinceOf("27"), "MH");
  assert.strictEqual(CO.provinceOf("22"), "CG");
  assert.strictEqual(CO.provinceOf("05"), "UK");
  assert.strictEqual(CO.provinceOf("Odisha"), "OR");
  assert.strictEqual(CO.phoneOf("098765 43210"), "+919876543210");
  assert.strictEqual(CO.phoneOf("9876543210"), "+919876543210");
});

test("payment link keeps the draft open", async () => {
  const r = await CO.createOrder({}, { customer: { name: "Asha Rao", phone: "9876543210", email: "" }, address: { name: "Asha Rao", address1: "1 Main Rd", city: "Pune", state: "27", zip: "411001" }, lines: [{ variantId: "gid://shopify/ProductVariant/9", quantity: 2, price: 500, basePrice: 550 }], shipping: { title: "Shipping", amount: 99 }, discount: { type: "percent", value: 0 }, payment: "link" });
  assert.deepStrictEqual(r.draft, { id: "gid://shopify/DraftOrder/1", name: "#D1", url: "https://x/pay", total: 1099 });
  const input = calls[0].v.input;
  assert.strictEqual(input.shippingAddress.provinceCode, "MH");
  assert.strictEqual(input.shippingAddress.lastName, "Rao");
  assert.deepStrictEqual(input.lineItems[0].priceOverride, { amount: "500", currencyCode: "INR" });
  assert.ok(!input.appliedDiscount);
  assert.strictEqual(input.shippingLine.priceWithCurrency.amount, "99");
  assert.strictEqual(calls.length, 1);
});

test("advance: completed as pending, advance recorded, order read by id", async () => {
  calls.length = 0;
  const r = await CO.createOrder({ organization: "o" }, { customer: { name: "Kamal G", phone: "9876543210" }, address: { name: "Kamal G", address1: "x", city: "Pune", state: "27", zip: "411001" }, lines: [{ variantId: "gid://shopify/ProductVariant/9", quantity: 1, price: 1099, basePrice: 1099 }], payment: "advance", advance: 500 });
  assert.strictEqual(r.order.name, "#201");
  assert.strictEqual(r.warning, "");
  const complete = calls.find((c) => c.q.includes("draftOrderComplete"));
  assert.strictEqual(complete.v.pending, true);
  const pay = calls.find((c) => c.q.includes("orderCreateManualPayment"));
  assert.deepStrictEqual(pay.v.amount, { amount: "500", currencyCode: "INR" });
  assert.ok(calls[0].v.input.tags.includes("Advance paid") && !calls[0].v.input.tags.includes("COD"));
  assert.ok(calls.some((c) => c.q.includes("order(id") && c.v.id === "gid://shopify/Order/77"));
});
