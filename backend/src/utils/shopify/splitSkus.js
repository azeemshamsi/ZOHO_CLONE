/**
 * Repair items that took in other products by name (names repeat; SKUs don't).
 * For each item, order lines (and the matching lines of invoices made from those orders) from a different
 * Shopify listing with a different SKU move to the item for that SKU (found by SKU or listing, else made).
 * Also sets each item's SKU to its own Shopify listing's latest SKU.
 */
const mongoose = require("mongoose");
const Item = require("../../models/Item");
const ShopifyOrder = require("../../models/ShopifyOrder");
const Invoice = require("../../models/Invoice");
const { itemName } = require("./catalog");

const low = (s) => String(s || "").trim().toLowerCase();
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function splitMergedItems({ dryRun = false, log = console.log } = {}) {
  const orders = await ShopifyOrder.find({ "lines.0": { $exists: true } }, { organization: 1, lines: 1, invoice: 1, orderDate: 1, name: 1 }).sort({ orderDate: 1 }).lean();
  const invIds = orders.map((o) => o.invoice).filter(Boolean);
  const invoices = new Map((await Invoice.find({ _id: { $in: invIds } }, { organization: 1, lineItems: 1 }).lean()).map((i) => [String(i._id), i]));

  // Every place an item is used for a Shopify line: { org, item, sku, variantId, line, ref }
  const recs = [];
  const latestSku = new Map(); // variantId → its latest SKU (orders are oldest first)
  for (const o of orders) {
    o.lines.forEach((l, i) => {
      if (l.variantId && l.sku) latestSku.set(l.variantId, l.sku.trim());
      if (l.item && l.variantId) recs.push({ org: String(o.organization), item: String(l.item), sku: (l.sku || "").trim(), variantId: l.variantId, line: l, ref: { model: ShopifyOrder, id: o._id, path: `lines.${i}.item` } });
    });
    const inv = o.invoice && invoices.get(String(o.invoice));
    if (!inv) continue;
    // Invoice lines were made from the order's lines with quantity, in order (shipping last).
    const active = o.lines.filter((l) => l.quantity > 0);
    active.forEach((l, i) => {
      const il = inv.lineItems[i];
      if (!il?.item || !l.variantId || Number(il.quantity) !== Number(l.quantity)) return;
      recs.push({ org: String(inv.organization), item: String(il.item), sku: (l.sku || "").trim(), variantId: l.variantId, line: l, ref: { model: Invoice, id: inv._id, path: `lineItems.${i}.item` } });
    });
  }

  const byItem = new Map();
  for (const r of recs) {
    const k = `${r.org}|${r.item}`;
    if (!byItem.has(k)) byItem.set(k, []);
    byItem.get(k).push(r);
  }
  const items = new Map((await Item.find({ _id: { $in: [...new Set(recs.map((r) => r.item))] } }).lean()).map((i) => [String(i._id), i]));
  const report = { skuUpdated: 0, split: [], linesMoved: 0 };

  for (const [k, list] of byItem) {
    const it = items.get(k.split("|")[1]);
    if (!it) continue;
    const org = it.organization;
    // The item's own listing: its Shopify variant, else the one most of its lines come from.
    let own = it.shopifyVariantId;
    if (!own) {
      const n = new Map();
      for (const r of list) n.set(r.variantId, (n.get(r.variantId) || 0) + 1);
      own = [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
    }
    const linked = new Set((it.shopifyLinks || []).map((l) => l.variantId));
    const ownSku = latestSku.get(own) || it.sku || "";
    const set = {};
    if (latestSku.get(own) && low(it.sku) !== low(latestSku.get(own))) set.sku = latestSku.get(own);
    if (!it.shopifyVariantId && own) set.shopifyVariantId = own;
    // Lines of other listings with a different SKU don't belong here.
    const foreign = list.filter((r) => r.variantId !== own && !linked.has(r.variantId) && r.sku && low(r.sku) !== low(ownSku));
    const bySku = new Map();
    for (const r of foreign) {
      const sk = low(latestSku.get(r.variantId) || r.sku);
      if (!bySku.has(sk)) bySku.set(sk, []);
      bySku.get(sk).push(r);
    }
    for (const [, rs] of bySku) {
      const r0 = rs[rs.length - 1];
      const sku = latestSku.get(r0.variantId) || r0.sku;
      let target = await Item.findOne({ organization: org, _id: { $ne: it._id }, sku: new RegExp(`^${esc(sku)}$`, "i") });
      if (!target) target = await Item.findOne({ organization: org, _id: { $ne: it._id }, $or: [{ shopifyVariantId: r0.variantId }, { "shopifyLinks.variantId": r0.variantId }] });
      let made = false;
      if (!target && !dryRun) {
        target = await Item.create({
          organization: org,
          type: "goods",
          name: itemName(r0.line),
          sku,
          unit: it.unit || "pcs",
          hsnSac: it.hsnSac,
          taxRate: it.taxRate,
          rate: it.rate,
          trackInventory: it.trackInventory,
          category: it.category,
          description: it.description,
          image: r0.line.image || "",
          shopifyVariantId: r0.variantId,
          packageType: it.packageType || null,
          needsReview: true,
          reviewNote: `Split from "${it.name}" (same name, different SKU) — check HSN, GST and price`,
        });
        made = true;
      }
      report.split.push({ from: it.name, fromSku: ownSku, to: target?.name || itemName(r0.line), sku, lines: rs.length, created: made || !target });
      if (dryRun) continue;
      for (const r of rs) await r.ref.model.updateOne({ _id: r.ref.id }, { $set: { [r.ref.path]: target._id } });
      report.linesMoved += rs.length;
    }
    if (Object.keys(set).length) {
      report.skuUpdated += set.sku ? 1 : 0;
      if (!dryRun) await Item.updateOne({ _id: it._id }, set);
    }
  }
  log(`SKU split: ${report.split.length} product(s) separated, ${report.linesMoved} line(s) moved, ${report.skuUpdated} SKU(s) updated`);
  for (const s of report.split.slice(0, 50)) log(`  "${s.from}" (${s.fromSku}) → "${s.to}" (${s.sku}), ${s.lines} line(s)${s.created ? ", new item" : ""}`);
  return report;
}

module.exports = { splitMergedItems };
void mongoose;
