const test = require("node:test");
const assert = require("node:assert");
const client = require("../src/utils/shopify/client");
const calls = [];
client.gql = async (store, q, v) => {
  calls.push({ q, v });
  if (q.includes("metafieldDefinitionCreate")) return { metafieldDefinitionCreate: { userErrors: [{ field: ["key"], message: "Key is in use", code: "TAKEN" }] } };
  if (q.includes("stagedUploadsCreate")) return { stagedUploadsCreate: { stagedTargets: [{ url: "https://up/x", resourceUrl: "https://up/res", parameters: [{ name: "key", value: "k" }] }], userErrors: [] } };
  if (q.includes("fileCreate")) return { fileCreate: { files: [{ id: "gid://shopify/MediaImage/7", fileStatus: "UPLOADED" }], userErrors: [] } };
  if (q.includes("node(id")) return { node: { fileStatus: "READY", image: { url: "https://cdn/x.png" } } };
  if (q.includes("order(id")) return { order: { note: "Created in OrdexaGo", metafield: { value: '["gid://shopify/MediaImage/1"]' } } };
  if (q.includes("orderUpdate")) return { orderUpdate: { order: { id: v.input.id }, userErrors: [] } };
  throw new Error("unexpected " + q);
};
global.fetch = async (url, opts) => {
  calls.push({ fetch: url, form: opts.body });
  return { ok: true, status: 204 };
};
const { sendToShopify } = require("../src/utils/shopify/paymentProof");

test("proof goes to Shopify files, metafield list and note", async () => {
  const store = {};
  const f = await sendToShopify(store, { shopifyId: "gid://shopify/Order/5" }, { name: "upi.png", type: "image/png", buf: Buffer.from("x"), reference: "UTR123", by: "Azeem" });
  assert.deepStrictEqual(f, { id: "gid://shopify/MediaImage/7", url: "https://cdn/x.png" });
  assert.strictEqual(store.paymentProofDef, true);
  const up = calls.find((c) => c.q?.includes("orderUpdate")).v.input;
  assert.strictEqual(up.metafields[0].value, '["gid://shopify/MediaImage/1","gid://shopify/MediaImage/7"]');
  assert.match(up.note, /^Created in OrdexaGo\nPayment proof \(.*Azeem, ref UTR123\): https:\/\/cdn\/x.png$/);
  assert.ok(calls.some((c) => c.fetch === "https://up/x"));
});
