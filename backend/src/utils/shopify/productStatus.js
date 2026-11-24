/**
 * Shopify product status on OrdexaGo items (ACTIVE / DRAFT / ARCHIVED, or GONE when the product was deleted),
 * so the Inventory tab can leave out store products that aren't for sale and have no stock.
 * An item with several listings (its own + linked ones) takes the best of them: active if any is active.
 * Refreshed every 6 hours and from the Inventory tab's "Refresh Shopify status".
 */
const Item = require("../../models/Item");
const ShopifyStore = require("../../models/ShopifyStore");

const num = (id) => String(id || "").replace(/^.*\//, "");
const RANK = { ACTIVE: 3, DRAFT: 2, ARCHIVED: 1, GONE: 0 };

async function variantStatuses(store) {
  const { gql } = require("./client");
  const out = new Map(); // numeric variant id → status
  let after = null;
  for (let page = 0; page < 400; page++) {
    const d = await gql(
      store,
      `query($after: String) { productVariants(first: 250, after: $after) { pageInfo { hasNextPage endCursor } nodes { id product { status } } } }`,
      { after },
    );
    for (const v of d.productVariants?.nodes || []) out.set(num(v.id), v.product?.status || "");
    if (!d.productVariants?.pageInfo?.hasNextPage) break;
    after = d.productVariants.pageInfo.endCursor;
  }
  return out;
}

// The best status among an item's listings; "" when it has none.
function statusOf(item, statuses) {
  const ids = [item.shopifyVariantId, ...(item.shopifyLinks || []).map((l) => l.variantId)].map(num).filter(Boolean);
  if (!ids.length) return "";
  let best = "GONE";
  for (const id of ids) {
    const s = statuses.get(id) || "GONE";
    if ((RANK[s] ?? 0) > RANK[best]) best = s;
  }
  return best;
}

async function refreshStore(store) {
  const statuses = await variantStatuses(store);
  if (!statuses.size) return { updated: 0 };
  const orgs = [store.organization, ...(store.sharedWith || [])];
  let updated = 0;
  for (const org of orgs) {
    const items = await Item.find({ organization: org }, { shopifyVariantId: 1, shopifyLinks: 1, shopifyStatus: 1 }).lean();
    for (const it of items) {
      const s = statusOf(it, statuses);
      if (s === (it.shopifyStatus || "")) continue;
      await Item.updateOne({ _id: it._id }, { $set: { shopifyStatus: s } });
      updated++;
    }
  }
  await ShopifyStore.updateOne({ _id: store._id }, { $set: { productStatusAt: new Date() } });
  return { updated, variants: statuses.size };
}

// The store an org's items belong to (its own, or the one shared with it).
async function storeOf(org) {
  return (
    (await ShopifyStore.findOne({ organization: org, connected: true })) ||
    (await ShopifyStore.findOne({ sharedWith: org, connected: true }))
  );
}

async function refreshOrg(org) {
  const store = await storeOf(org);
  if (!store) throw new (require("../http").HttpError)(400, "No Shopify store is connected");
  return refreshStore(store);
}

async function refreshAll() {
  for (const store of await ShopifyStore.find({ connected: true })) {
    try {
      await refreshStore(store);
    } catch (e) {
      console.error(`Shopify product status (${store.shop}) failed:`, e.message);
    }
  }
}

module.exports = { refreshAll, refreshOrg, statusOf, variantStatuses };
