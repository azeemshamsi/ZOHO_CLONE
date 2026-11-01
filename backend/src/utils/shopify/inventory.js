/**
 * Push OrdexaGo stock to Shopify (inventorySetQuantities, "available" at the chosen location).
 * Every change to stock (invoices, bills, adjustments, transfers, Shopify orders, item settings) schedules a
 * push a few seconds later; only quantities that changed are sent. A full check also runs every 30 minutes.
 */
const crypto = require("crypto");
const ShopifyStore = require("../../models/ShopifyStore");
const Item = require("../../models/Item");
const { gql } = require("./client");
const { stockView } = require("../stockview");

const timers = new Map();
const running = new Map();

function schedulePush(org, delay = 4000) {
  if (process.env.NODE_ENV === "test") return;
  clearTimeout(timers.get(org));
  timers.set(
    org,
    setTimeout(() => {
      timers.delete(org);
      pushOrg(org).catch((e) => console.error(`Inventory sync failed: ${e.message}`));
    }, delay).unref()
  );
}

// Inventory item ids for variants we don't know yet; turns on tracking where Shopify has it off.
async function resolveInventoryItems(store, items) {
  const need = [];
  for (const it of items) {
    if (it.shopifyVariantId && !it.shopifyInventoryItemId) need.push(it.shopifyVariantId);
    for (const l of it.shopifyLinks || []) if (l.variantId && !l.inventoryItemId) need.push(l.variantId);
  }
  const found = {};
  for (let i = 0; i < need.length; i += 100) {
    const data = await gql(store, `query($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { id inventoryItem { id tracked } } } }`, { ids: need.slice(i, i + 100) });
    for (const n of data.nodes || []) {
      if (!n?.inventoryItem) continue;
      found[n.id] = n.inventoryItem.id;
      if (n.inventoryItem.tracked === false) await gql(store, `mutation($id: ID!) { inventoryItemUpdate(id: $id, input: { tracked: true }) { userErrors { message } } }`, { id: n.inventoryItem.id }).catch(() => {});
    }
  }
  for (const it of items) {
    let changed = false;
    if (it.shopifyVariantId && !it.shopifyInventoryItemId && found[it.shopifyVariantId]) {
      it.shopifyInventoryItemId = found[it.shopifyVariantId];
      changed = true;
    }
    for (const l of it.shopifyLinks || [])
      if (!l.inventoryItemId && found[l.variantId]) {
        l.inventoryItemId = found[l.variantId];
        changed = true;
      }
    if (changed) await Item.updateOne({ _id: it._id }, { shopifyInventoryItemId: it.shopifyInventoryItemId, shopifyLinks: it.shopifyLinks });
  }
}

const SET = (key) => `mutation($input: InventorySetQuantitiesInput!) { inventorySetQuantities(input: $input) @idempotent(key: "${key}") { inventoryAdjustmentGroup { id } userErrors { code field message } } }`;

async function setQuantities(store, quantities) {
  const input = { name: "available", reason: "correction", referenceDocumentUri: "mgi://inventory-sync", quantities: quantities.map((q) => ({ inventoryItemId: q.inventoryItemId, locationId: store.locationId, quantity: q.quantity, changeFromQuantity: null })) };
  const res = await gql(store, SET(crypto.randomUUID()), { input });
  return res.inventorySetQuantities?.userErrors || [];
}

async function pushOrg(org, { force = false, itemIds } = {}) {
  if (running.get(org)) {
    schedulePush(org, 5000);
    return { skipped: "busy" };
  }
  const store = await ShopifyStore.findOne({ organization: org });
  if (!store || !store.connected || !store.inventorySync || !store.locationId) return { skipped: "off" };
  running.set(org, true);
  const errors = [];
  let pushed = 0;
  try {
    const items = await Item.find({ organization: org, shopifySync: { $ne: false }, $or: [{ shopifyVariantId: { $nin: ["", null] } }, { "shopifyLinks.0": { $exists: true } }], ...(itemIds ? { _id: { $in: itemIds } } : {}) });
    if (!items.length) return { pushed: 0 };
    await resolveInventoryItems(store, items);
    const { rows } = await stockView(org, { itemIds: items.map((i) => i._id) });
    const qty = new Map(rows.map((r) => [String(r._id), r.shopify]));
    const batch = []; // {inventoryItemId, quantity, item, variantId}
    for (const it of items) {
      const q = qty.get(String(it._id));
      if (q === null || q === undefined) continue;
      const targets = [...(it.shopifyVariantId ? [{ variantId: it.shopifyVariantId, inventoryItemId: it.shopifyInventoryItemId }] : []), ...(it.shopifyLinks || [])];
      for (const t of targets) {
        if (!t.inventoryItemId) {
          errors.push(`${it.name}: Shopify variant ${t.variantId.split("/").pop()} not found`);
          continue;
        }
        if (!force && (it.shopifyPushed || {})[t.variantId] === q) continue;
        batch.push({ inventoryItemId: t.inventoryItemId, quantity: q, item: it, variantId: t.variantId });
      }
    }
    for (let i = 0; i < batch.length; i += 100) {
      const part = batch.slice(i, i + 100);
      let errs = await setQuantities(store, part);
      // Not stocked at the location yet: activate and try again.
      const notStocked = errs.filter((e) => /not stocked|NOT_STOCKED|inactive/i.test(`${e.code} ${e.message}`));
      if (notStocked.length) {
        for (const p of part) await gql(store, `mutation($i: ID!, $l: ID!) { inventoryActivate(inventoryItemId: $i, locationId: $l) { userErrors { message } } }`, { i: p.inventoryItemId, l: store.locationId }).catch(() => {});
        errs = await setQuantities(store, part);
      }
      if (errs.length) errors.push(...errs.map((e) => e.message));
      else {
        pushed += part.length;
        for (const p of part) p.item.shopifyPushed = { ...(p.item.shopifyPushed || {}), [p.variantId]: p.quantity };
      }
    }
    for (const it of new Set(batch.map((b) => b.item))) await Item.updateOne({ _id: it._id }, { shopifyPushed: it.shopifyPushed });
  } catch (e) {
    errors.push(e.message);
  } finally {
    running.delete(org);
  }
  await ShopifyStore.updateOne({ _id: store._id }, { pushStatus: { at: new Date(), pushed, errors: [...new Set(errors)].slice(0, 20) } });
  return { pushed, errors };
}

async function pushAll() {
  for (const s of await ShopifyStore.find({ connected: true, inventorySync: true }, { organization: 1 })) await pushOrg(String(s.organization)).catch(() => {});
}

async function locations(store) {
  const d = await gql(store, `{ locations(first: 50) { nodes { id name isActive fulfillsOnlineOrders } } }`);
  return (d.locations?.nodes || []).filter((l) => l.isActive !== false);
}

// Shopify variants to link (search by title or SKU).
async function searchVariants(store, q) {
  const query = q ? (/^[\w-]+$/.test(q) && /\d/.test(q) ? `sku:${q}* OR title:*${q}*` : `title:*${q}*`) : "";
  const d = await gql(store, `query($q: String) { productVariants(first: 30, query: $q) { nodes { id sku title displayName image { url } inventoryItem { id } product { title } } } }`, { q: query || null });
  return (d.productVariants?.nodes || []).map((v) => ({ variantId: v.id, inventoryItemId: v.inventoryItem?.id || "", sku: v.sku || "", title: v.displayName || `${v.product?.title} - ${v.title}`, image: v.image?.url || "" }));
}

module.exports = { schedulePush, pushOrg, pushAll, locations, searchVariants };
