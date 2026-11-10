const test = require("node:test");
const assert = require("node:assert");
const { expand, permit, anyOf } = require("../src/utils/roles");

const run = (perms, mod, method = "GET") => {
  let ok = false;
  let code = 0;
  permit(mod)({ method, perms: expand(perms), user: {} }, { status: (c) => ((code = c), { send: () => {} }) }, () => (ok = true));
  return ok || code;
};

test("a role with only Purchase Orders: POs yes, bills and sales no, vendor list readable", () => {
  const p = { purchases: "none", "purchases.purchase_orders": "full" };
  assert.equal(run(p, "purchases.purchase_orders", "POST"), true);
  assert.equal(run(p, "purchases.bills"), 403);
  assert.equal(run(p, "purchases.vendors", "POST"), 403);
  assert.equal(run(p, anyOf("purchases")), true); // vendor dropdown on the PO form
  assert.equal(run(p, "sales.invoices"), 403);
  assert.equal(run(p, "purchases"), 403); // module-wide things like the dashboard
});

test("pages follow their module unless set", () => {
  const e = expand({ sales: "full", "sales.invoices": "view" });
  assert.equal(e["sales.quotes"], "full");
  assert.equal(e["sales.invoices"], "view");
  assert.equal(expand({})["purchases.bills"], "none");
});

test("seller purchase price: Shopify cost first, else rate% of the sale price", () => {
  const S = require("../src/utils/sellers");
  const seller = { rate: 50 };
  const l = { variantId: "gid://shopify/ProductVariant/1", unitPrice: 4910, quantity: 2 };
  assert.equal(S.linePurchase(seller, l, new Map([["gid://shopify/ProductVariant/1", 1800]])), 3600);
  assert.equal(S.linePurchase(seller, l, new Map()), 4910);
  assert.equal(S.linePurchase(seller, l), 4910);
  assert.match(S.priceNote(seller, l, new Map([[l.variantId, 1800]])), /Shopify cost ₹1800/);
});
