/**
 * Flipkart stock follows Shopify: every 30 minutes each Shopify SKU that is listed on Flipkart gets the Shopify
 * available quantity (minus the account's buffer). Which SKUs are on Flipkart (and their FSN / location) is
 * looked up once a day, 10 SKUs per call. Only changed quantities are sent.
 * New Flipkart orders take their quantity off the Shopify stock (so Shopify and the other channels see it), and
 * a cancellation before dispatch puts it back.
 */
const crypto = require("crypto");
const FlipkartAccount = require("../../models/FlipkartAccount");
const ShopifyStore = require("../../models/ShopifyStore");
const { call } = require("./client");

const storeFor = async (acc) => ShopifyStore.findOne({ organization: await require("./orders").storeOrgFor(acc.organization) });

async function locationOf(store) {
  if (store.locationId) return store.locationId;
  const locs = await require("../shopify/inventory").locations(store);
  if (!locs.length) throw new Error("The Shopify store has no active location");
  return locs[0].id;
}

// SKU → { qty (available, all locations), tracked } for every Shopify variant with a SKU.
async function shopifyStock(store) {
  const { gql } = require("../shopify/client");
  const out = new Map();
  let after = null;
  for (let page = 0; page < 200; page++) {
    const d = await gql(store, `query($after: String) { productVariants(first: 250, after: $after, query: "sku:*") { pageInfo { hasNextPage endCursor } nodes { sku inventoryQuantity inventoryItem { tracked } product { status } } } }`, { after });
    for (const v of d.productVariants?.nodes || []) {
      const sku = String(v.sku || "").trim();
      if (!sku) continue;
      const prev = out.get(sku);
      const qty = Math.max(0, Number(v.inventoryQuantity) || 0) + (prev?.qty || 0);
      out.set(sku, { qty, tracked: v.inventoryItem?.tracked !== false, active: v.product?.status === "ACTIVE" || !!prev?.active });
    }
    if (!d.productVariants?.pageInfo?.hasNextPage) break;
    after = d.productVariants.pageInfo.endCursor;
  }
  return out;
}

// Which SKUs are listed on Flipkart: { sku: { productId, locations: [ids] } | null }.
async function lookupListings(acc, skus) {
  const found = {};
  for (let i = 0; i < skus.length; i += 10) {
    const chunk = skus.slice(i, i + 10);
    try {
      const r = await call(acc, "GET", `/listings/v3/${chunk.map(encodeURIComponent).join(",")}`);
      const avail = r.available || {};
      for (const sku of chunk) {
        const v = avail[sku];
        if (!v) {
          found[sku] = null;
          continue;
        }
        const locs = (v.locations || v.listing_locations || []).map((l) => l.id || l.location_id).filter(Boolean);
        found[sku] = { productId: v.product_id || v.productId || v.fsn || "", locations: locs };
      }
    } catch (e) {
      if (e.status === 401 || /token/i.test(e.message)) throw e;
      for (const sku of chunk) found[sku] = found[sku] ?? undefined;
    }
  }
  return found;
}

async function syncStock(acc, { relist = false } = {}) {
  acc.stock = { ...(acc.stock?.toObject ? acc.stock.toObject() : acc.stock || {}), running: true, startedAt: new Date(), updated: 0, failed: 0, error: "", errors: [] };
  await acc.save();
  try {
    const store = await storeFor(acc);
    if (!store) throw new Error("Connect the Shopify store first — Flipkart's stock follows it");
    const stock = await shopifyStock(store);
    const listings = { ...(acc.listings || {}) };
    const stale = relist || !acc.listingsAt || Date.now() - acc.listingsAt > 86400000;
    const toCheck = [...stock.keys()].filter((sku) => stale || !(sku in listings));
    if (toCheck.length) {
      const found = await lookupListings(acc, toCheck);
      for (const [sku, v] of Object.entries(found)) {
        if (v === undefined) continue;
        listings[sku] = v ? { ...(listings[sku] || {}), ...v } : null;
      }
      if (stale) acc.listingsAt = new Date();
    }
    const buffer = Number(acc.stockBuffer) || 0;
    const todo = Object.entries(listings).filter(([sku, l]) => l?.productId && stock.has(sku) && stock.get(sku).tracked);
    const updates = todo
      .map(([sku, l]) => ({ sku, l, qty: stock.get(sku).active ? Math.max(0, stock.get(sku).qty - buffer) : 0 }))
      .filter((u) => u.l.pushed !== u.qty || relist);
    const locs = (l) => (l.locations?.length ? l.locations : acc.locationId ? [acc.locationId] : []);
    for (let i = 0; i < updates.length; i += 10) {
      const chunk = updates.slice(i, i + 10).filter((u) => locs(u.l).length);
      if (!chunk.length) continue;
      const body = Object.fromEntries(chunk.map((u) => [u.sku, { product_id: u.l.productId, locations: locs(u.l).map((id) => ({ id, inventory: u.qty })) }]));
      try {
        const r = await call(acc, "POST", "/listings/v3/update/inventory", { body });
        for (const u of chunk) {
          const res = r[u.sku] || {};
          if (!res.status || /success/i.test(res.status)) {
            listings[u.sku] = { ...u.l, pushed: u.qty, at: new Date() };
            acc.stock.updated++;
          } else {
            acc.stock.failed++;
            if (acc.stock.errors.length < 20) acc.stock.errors.push(`${u.sku}: ${(res.errors || []).map((e) => e.description || e.code).join("; ") || res.status}`);
          }
        }
      } catch (e) {
        acc.stock.failed += chunk.length;
        if (acc.stock.errors.length < 20) acc.stock.errors.push(`${chunk.map((u) => u.sku).join(", ")}: ${e.message}`);
      }
    }
    acc.listings = listings;
    acc.markModified("listings");
    acc.stock.listings = Object.values(listings).filter((l) => l?.productId).length;
  } catch (e) {
    acc.stock.error = e.message;
  }
  acc.stock.running = false;
  acc.stock.finishedAt = new Date();
  acc.markModified("stock");
  await acc.save();
  return acc.stock;
}

async function syncAllStock() {
  for (const acc of await FlipkartAccount.find({ connected: true, stockSync: { $ne: false } })) {
    if (acc.stock?.running && acc.stock.startedAt > new Date(Date.now() - 60 * 60000)) continue;
    await syncStock(acc).catch((e) => console.error("Flipkart stock sync failed:", e.message));
  }
}

/* ---------------- Shopify stock for Flipkart orders ---------------- */
async function adjustShopify(acc, order, sign, note) {
  if (acc.reduceShopify === false) return;
  const store = await storeFor(acc);
  if (!store) return;
  const { gql } = require("../shopify/client");
  const skus = [...new Set(order.lines.filter((l) => l.sku && l.quantity > 0).map((l) => l.sku))];
  if (!skus.length) return;
  const q = skus.map((s) => `sku:"${s.replace(/"/g, '\\"')}"`).join(" OR ");
  const d = await gql(store, `query($q: String) { productVariants(first: 50, query: $q) { nodes { sku inventoryItem { id tracked } } } }`, { q });
  const bySku = new Map((d.productVariants?.nodes || []).filter((v) => v.inventoryItem?.tracked !== false).map((v) => [v.sku, v.inventoryItem.id]));
  const loc = await locationOf(store);
  const changes = order.lines.filter((l) => bySku.has(l.sku) && l.quantity > 0).map((l) => ({ inventoryItemId: bySku.get(l.sku), locationId: loc, delta: sign * l.quantity }));
  if (!changes.length) return;
  const r = await gql(store, `mutation($input: InventoryAdjustQuantitiesInput!) { inventoryAdjustQuantities(input: $input) @idempotent(key: "${crypto.randomUUID()}") { userErrors { message } } }`, {
    input: { name: "available", reason: "correction", referenceDocumentUri: `ordexago://flipkart/${order.flipkart?.shipmentId}/${note}`, changes },
  });
  const errs = r.inventoryAdjustQuantities?.userErrors || [];
  if (errs.length) throw new Error(errs.map((e) => e.message).join("; "));
  return changes.length;
}

async function takeFromShopify(acc, order) {
  if (order.flipkart?.stockTakenAt) return;
  const n = await adjustShopify(acc, order, -1, "order");
  if (n) {
    order.flipkart = { ...order.flipkart, stockTakenAt: new Date() };
    order.markModified("flipkart");
    await order.save();
  }
}

async function giveBackToShopify(acc, order) {
  if (!order.flipkart?.stockTakenAt || order.flipkart.stockReturnedAt) return;
  await adjustShopify(acc, order, 1, "cancelled");
  order.flipkart = { ...order.flipkart, stockReturnedAt: new Date() };
  order.markModified("flipkart");
  await order.save();
}

module.exports = { syncStock, syncAllStock, takeFromShopify, giveBackToShopify, shopifyStock };
