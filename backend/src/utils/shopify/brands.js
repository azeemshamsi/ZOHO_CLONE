/**
 * A seller's brand on Shopify: a collection of the brand's products (rule: Vendor equals the brand), published to the
 * Online Store, so the brand has its own page (woodentwist.com/collections/<handle>) and new products of the brand join
 * it on their own. Needs the write_products scope (and write_publications to publish it).
 */
const { gql } = require("./client");
const ShopifyStore = require("../../models/ShopifyStore");

const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');

// The Online Store publication (cached per store for the process).
const pubCache = new Map();
async function onlineStore(store) {
  const k = String(store._id || store.shop);
  if (pubCache.has(k)) return pubCache.get(k);
  const d = await gql(
    store,
    `{ publications(first: 30) { nodes { id catalog { title } } } }`,
  );
  const p = (d.publications?.nodes || []).find((x) =>
    /online store/i.test(x.catalog?.title || ""),
  );
  if (p) pubCache.set(k, p.id);
  return p?.id || null;
}

async function publish(store, id) {
  const pub = await onlineStore(store).catch(() => null);
  if (!pub)
    return {
      published: false,
      note: "Online Store channel not found — publish the collection in Shopify",
    };
  try {
    const r = await gql(
      store,
      `mutation($id: ID!, $p: [PublicationInput!]!) { publishablePublish(id: $id, input: $p) { userErrors { message } } }`,
      { id, p: [{ publicationId: pub }] },
    );
    const errs = r.publishablePublish?.userErrors || [];
    if (errs.length)
      return { published: false, note: errs.map((e) => e.message).join("; ") };
    return { published: true };
  } catch (e) {
    return {
      published: false,
      note: /scope|access/i.test(e.message)
        ? "Add the write_publications scope to publish it on the website"
        : e.message,
    };
  }
}

// Find the brand's collection (a smart collection on its Vendor) or create it. → { id, handle, created, published, note }
async function ensureBrand(store, brand) {
  const name = String(brand || "").trim();
  if (!name) throw new Error("No brand name");
  const found = await gql(
    store,
    `query($q: String!) { collections(first: 20, query: $q) { nodes { id handle title ruleSet { rules { column relation condition } } } } }`,
    { q: `title:"${esc(name)}"` },
  );
  const same = (found.collections?.nodes || []).find(
    (c) =>
      (c.ruleSet?.rules || []).some(
        (r) =>
          r.column === "VENDOR" &&
          r.relation === "EQUALS" &&
          r.condition.trim().toLowerCase() === name.toLowerCase(),
      ) || c.title.trim().toLowerCase() === name.toLowerCase(),
  );
  if (same)
    return {
      id: same.id,
      handle: same.handle,
      created: false,
      ...(await publish(store, same.id)),
    };
  const r = await gql(
    store,
    `mutation($input: CollectionInput!) { collectionCreate(input: $input) { collection { id handle } userErrors { field message } } }`,
    {
      input: {
        title: name,
        descriptionHtml: `<p>Shop ${name.replace(/[<>&]/g, "")} products on WoodenTwist.</p>`,
        ruleSet: {
          appliedDisjunctively: false,
          rules: [{ column: "VENDOR", relation: "EQUALS", condition: name }],
        },
      },
    },
  );
  const errs = r.collectionCreate?.userErrors || [];
  if (errs.length) throw new Error(errs.map((e) => e.message).join("; "));
  const c = r.collectionCreate.collection;
  return {
    id: c.id,
    handle: c.handle,
    created: true,
    ...(await publish(store, c.id)),
  };
}

// Every brand of a seller: create what's missing, remember the result on the seller (errors too). Never throws.
async function syncSellerBrands(seller) {
  const out = { ...(seller.shopifyBrands || {}) };
  const store = await ShopifyStore.findOne({
    organization: seller.organization,
  });
  if (!store?.connected) {
    for (const b of seller.brands || [])
      if (!out[b]?.id)
        out[b] = { error: "Shopify store isn't connected", at: new Date() };
  } else {
    for (const b of seller.brands || []) {
      if (out[b]?.id && out[b]?.published) continue;
      try {
        const r = await ensureBrand(store, b);
        out[b] = {
          id: r.id,
          handle: r.handle,
          published: !!r.published,
          note: r.note || "",
          created: r.created || out[b]?.created || false,
          at: new Date(),
        };
      } catch (e) {
        out[b] = {
          error: /scope|access denied/i.test(e.message)
            ? "The Shopify app needs the write_products scope to create brands — add it, release and reinstall the app"
            : e.message,
          at: new Date(),
        };
      }
    }
  }
  // Brands no longer on the seller are forgotten here (their Shopify collection stays).
  for (const k of Object.keys(out))
    if (!(seller.brands || []).includes(k)) delete out[k];
  seller.shopifyBrands = out;
  seller.markModified?.("shopifyBrands");
  const Seller = require("../../models/Seller");
  await Seller.updateOne({ _id: seller._id }, { $set: { shopifyBrands: out } });
  return out;
}

module.exports = { ensureBrand, syncSellerBrands, onlineStore, publish };
