/**
 * One-time data changes, run at start-up. Each runs once per database (recorded in `migrations`).
 */
const mongoose = require("mongoose");

const MIGRATIONS = [
  {
    // Shopify stock sync per item used to start on; it now starts off until the user turns it on.
    id: "2026-11-item-shopify-sync-off",
    run: async () => {
      const Item = require("../models/Item");
      await Item.updateMany({ shopifySync: { $ne: false }, shopifySyncByUser: { $ne: true } }, { $set: { shopifySync: false } });
    },
  },
  {
    // Shopify orders paid "manual" / pending or tagged COD (e.g. "CASHFREE - COD") were taken as prepaid.
    id: "2026-11-shopify-cod-from-tags-and-pending",
    run: async () => {
      const ShopifyOrder = require("../models/ShopifyOrder");
      const rx = /\bcod\b|cash on delivery|cash_on_delivery|cash-on-delivery/i;
      const list = await ShopifyOrder.find({ paymentMode: "prepaid", $or: [{ tags: { $regex: rx } }, { financialStatus: "PENDING" }] }, { total: 1, outstanding: 1, prepaidAmount: 1 }).lean();
      for (const o of list) {
        if ((o.prepaidAmount || 0) >= 0.5) continue;
        await ShopifyOrder.updateOne({ _id: o._id }, { paymentMode: "cod", codAmount: o.outstanding || o.total || 0, prepaidAmount: 0 });
      }
      console.log(`COD fix: ${list.length} order(s) checked`);
    },
  },
  {
    // Items matched to a Shopify listing (e.g. Tally items) never got the listing's SKU.
    id: "2026-11-item-sku-from-shopify",
    run: async () => {
      const Item = require("../models/Item");
      const ShopifyOrder = require("../models/ShopifyOrder");
      const skus = await ShopifyOrder.aggregate([{ $unwind: "$lines" }, { $match: { "lines.variantId": { $nin: ["", null] }, "lines.sku": { $nin: ["", null] } } }, { $group: { _id: "$lines.variantId", sku: { $first: "$lines.sku" } } }]);
      const by = new Map(skus.map((s) => [s._id, s.sku]));
      const items = await Item.find({ shopifyVariantId: { $nin: ["", null] }, $or: [{ sku: "" }, { sku: null }, { sku: { $exists: false } }] }, { shopifyVariantId: 1 }).lean();
      let n = 0;
      for (const it of items) {
        const sku = by.get(it.shopifyVariantId);
        if (sku) {
          await Item.updateOne({ _id: it._id }, { sku });
          n++;
        }
      }
      console.log(`SKU backfill: ${n} item(s)`);
    },
  },
  {
    // Products with the same name but different SKUs had been merged into one item: separate them.
    id: "2026-11-split-items-by-sku",
    run: async () => {
      const { splitMergedItems } = require("./shopify/splitSkus");
      const r = await splitMergedItems();
      const db = mongoose.connection.db;
      await db.collection("migration_reports").updateOne({ _id: "split-items-by-sku" }, { $set: { at: new Date(), ...r } }, { upsert: true });
    },
  },
  {
    // Orders still "shipped" although their Shopify fulfilment was cancelled.
    id: "2026-11-cancelled-shopify-fulfilments",
    run: async () => {
      const ShopifyOrder = require("../models/ShopifyOrder");
      const { undoCancelledFulfilment } = require("./shopify/sync");
      const list = await ShopifyOrder.find({ status: { $in: ["shipped", "ready_to_ship"] }, fulfillmentStatus: { $in: ["UNFULFILLED", "OPEN", "PENDING_FULFILLMENT", "ON_HOLD", "SCHEDULED"] } });
      let n = 0;
      // Fulfilments were stored without their status, so a stored one on an unfulfilled order was cancelled.
      for (const o of list) if (undoCancelledFulfilment(o, (o.shopifyFulfillments || []).length > 0)) (await o.save(), n++);
      console.log(`Cancelled Shopify fulfilments: ${n} order(s) put back`);
    },
  },
  {
    // Tally sales / purchase ledgers imported before they were marked as such: mark them from their use.
    id: "2026-11-ledger-kinds-from-use",
    run: async () => {
      const r = await require("./import/ledgerKinds").markLedgerKinds();
      console.log(`Ledger kinds: ${r.sales} sales and ${r.purchase} purchase ledger(s) marked`);
    },
  },
];

async function runMigrations() {
  const done = mongoose.connection.db.collection("migrations");
  for (const m of MIGRATIONS) {
    try {
      if (await done.findOne({ _id: m.id })) continue;
      await m.run();
      await done.insertOne({ _id: m.id, at: new Date() });
      console.log(`Migration ${m.id} done`);
    } catch (e) {
      console.error(`Migration ${m.id} failed: ${e.message}`);
    }
  }
}

module.exports = { runMigrations };
