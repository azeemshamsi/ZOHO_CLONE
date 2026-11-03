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
