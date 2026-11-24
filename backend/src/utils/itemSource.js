// Store items vs the rest, and where an item came from: used by the Items list and the Inventory tab.
const onStore = (i) => !!i.shopifyVariantId || (i.shopifyLinks || i.links || []).length > 0;
const srcOf = (i) => i.source || (i.shopifyVariantId ? "shopify" : "");
const SOURCE_FILTERS = {
  store: onStore,
  not_store: (i) => !onStore(i),
  from_shopify: (i) => srcOf(i) === "shopify",
  tally: (i) => srcOf(i) === "tally",
  imported: (i) => ["zoho", "sheet"].includes(srcOf(i)),
  ordexago: (i) => srcOf(i) === "ordexago" || srcOf(i) === "",
  seller: (i) => !!i.seller,
};

// Shown in the Inventory tab: not a marketplace seller's product, and — for products that came from Shopify —
// active on the store, unless stock is still held. Tally / OrdexaGo items always show.
function inInventory(i, onHand) {
  if (i.seller) return false;
  if (srcOf(i) !== "shopify") return true;
  const st = i.shopifyStatus || "";
  if (!st || st === "ACTIVE") return true;
  return (onHand || 0) > 0;
}

module.exports = { onStore, srcOf, SOURCE_FILTERS, inInventory };
