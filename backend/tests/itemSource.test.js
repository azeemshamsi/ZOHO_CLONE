const test = require("node:test");
const assert = require("node:assert");
const { inInventory, SOURCE_FILTERS } = require("../src/utils/itemSource");
const { statusOf } = require("../src/utils/shopify/productStatus");

test("inventory tab: sellers out; Shopify products only when active or with stock", () => {
  assert.strictEqual(inInventory({ seller: "x" }, 5), false);
  assert.strictEqual(inInventory({ source: "tally", shopifyStatus: "DRAFT" }, 0), true);
  assert.strictEqual(inInventory({ source: "shopify", shopifyStatus: "ACTIVE" }, 0), true);
  assert.strictEqual(inInventory({ source: "shopify", shopifyStatus: "DRAFT" }, 0), false);
  assert.strictEqual(inInventory({ source: "shopify", shopifyStatus: "ARCHIVED" }, 3), true);
  assert.strictEqual(inInventory({ shopifyVariantId: "1", shopifyStatus: "GONE" }, 0), false);
  assert.strictEqual(inInventory({ source: "shopify", shopifyStatus: "" }, 0), true);
  assert.strictEqual(SOURCE_FILTERS.store({ links: [{ variantId: "1" }] }), true);
});

test("status: best of own and linked listings; deleted is GONE", () => {
  const st = new Map([["11", "DRAFT"], ["22", "ACTIVE"]]);
  assert.strictEqual(statusOf({ shopifyVariantId: "gid://shopify/ProductVariant/11", shopifyLinks: [{ variantId: "22" }] }, st), "ACTIVE");
  assert.strictEqual(statusOf({ shopifyVariantId: "11" }, st), "DRAFT");
  assert.strictEqual(statusOf({ shopifyVariantId: "99" }, st), "GONE");
  assert.strictEqual(statusOf({}, st), "");
});
