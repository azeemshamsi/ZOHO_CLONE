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
