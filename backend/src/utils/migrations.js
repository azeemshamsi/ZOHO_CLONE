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
