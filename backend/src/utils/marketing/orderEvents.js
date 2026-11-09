/**
 * Store order status changes as events (emitted from the ShopifyOrder model after every save, which covers
 * Shopify sync (utils/shopify/sync.js upsert), courier booking / tracking (utils/shopify/ship.js) and manual
 * changes). Listeners run on the next tick and their errors are swallowed: the original action never waits
 * for them or fails because of them.
 */
const { EventEmitter } = require("events");

const bus = new EventEmitter();
bus.setMaxListeners(20);

function emitChange(doc, change) {
  if (!bus.listenerCount("change")) return;
  setImmediate(() => {
    for (const l of bus.listeners("change")) {
      try {
        Promise.resolve(l(doc, change)).catch((e) => console.error(`[order events] ${e.message}`));
      } catch (e) {
        console.error(`[order events] ${e.message}`);
      }
    }
  });
}

module.exports = { bus, emitChange };
