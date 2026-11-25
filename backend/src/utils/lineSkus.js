// Each document line's SKU (from its item), for printing and showing on the invoice.
async function withSkus(lineItems = []) {
  const ids = [...new Set(lineItems.map((l) => (l.item ? String(l.item._id || l.item) : "")).filter((x) => /^[0-9a-f]{24}$/.test(x)))];
  if (!ids.length) return lineItems.map((l) => ({ ...(l.toObject ? l.toObject() : l) }));
  const Item = require("../models/Item");
  const sku = new Map((await Item.find({ _id: { $in: ids } }, { sku: 1 }).lean()).map((i) => [String(i._id), i.sku || ""]));
  return lineItems.map((l) => {
    const o = l.toObject ? l.toObject() : { ...l };
    o.sku = sku.get(String(l.item?._id || l.item || "")) || "";
    return o;
  });
}
module.exports = { withSkus };
