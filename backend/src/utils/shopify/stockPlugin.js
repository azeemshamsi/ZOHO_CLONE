// Mongoose plugin (registered before any model loads): a write to a stock-related model schedules
// a Shopify inventory push for that organization. Requires nothing at load time, to stay first.
const WATCHED = new Set(["Invoice", "CreditNote", "Bill", "VendorCredit", "InventoryAdjustment", "TransferOrder", "ShopifyOrder", "Item"]);
const QUIET = new Set(["shopifyPushed", "shopifyInventoryItemId", "$set", "$setOnInsert"]);

function fire(modelName, org) {
  if (!WATCHED.has(modelName) || !org) return;
  require("./inventory").schedulePush(String(org));
}

module.exports = function stockPlugin(schema) {
  schema.post("save", function () {
    fire(this.constructor.modelName, this.organization);
  });
  for (const op of ["findOneAndUpdate", "updateOne", "updateMany", "deleteOne", "deleteMany", "findOneAndDelete"])
    schema.post(op, function () {
      const u = this.getUpdate ? this.getUpdate() || {} : {};
      const keys = [...Object.keys(u), ...Object.keys(u.$set || {})];
      if (keys.length && keys.every((k) => QUIET.has(k))) return; // bookkeeping from the push itself
      const f = this.getFilter ? this.getFilter() : {};
      fire(this.model?.modelName, f.organization);
    });
  schema.post("insertMany", function (docs) {
    if (docs?.[0]) fire(this.modelName, docs[0].organization);
  });
};
