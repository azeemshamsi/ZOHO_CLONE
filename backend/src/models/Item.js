const mongoose = require("mongoose");

const itemSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    type: { type: String, enum: ["goods", "service"], default: "goods" },
    name: { type: String, required: true, trim: true },
    sku: { type: String, default: "" },
    unit: { type: String, default: "pcs" },
    hsnSac: { type: String, default: "" },
    rate: { type: Number, default: 0 }, // selling price (excl. tax)
    purchaseRate: { type: Number, default: 0 },
    taxRate: { type: Number, default: 18 }, // GST %
    description: { type: String, default: "" },
    active: { type: Boolean, default: true },
    // Inventory (goods only)
    trackInventory: { type: Boolean, default: false },
    openingStock: { type: Number, default: 0 },
    openingStockRate: { type: Number, default: 0 }, // cost per unit of the opening stock
    openingStockDate: { type: Date },
    openingWarehouse: { type: mongoose.Schema.Types.ObjectId, ref: "Warehouse" },
    reorderLevel: { type: Number, default: 0 },
    category: { type: String, default: "" },
    image: { type: String, default: "" },
    weight: { type: Number, default: 0 }, // kg
    // Stock shown on Shopify but not held: made-to-order capacity. No effect on the books.
    virtualStock: { type: Number, default: 0 },
    bufferStock: { type: Number, default: 0 }, // kept back from Shopify
    shopifySync: { type: Boolean, default: true }, // push this item's stock to Shopify
    // Created from a Shopify order: the variant it came from and any GST/HSN corrections to check.
    shopifyVariantId: { type: String, default: "" },
    shopifyInventoryItemId: { type: String, default: "" },
    // Other Shopify products that are really this item (e.g. 4 listings of one metal table).
    // Their orders use this item's stock, and this item's stock is pushed to all of them.
    shopifyLinks: {
      type: [{ _id: false, variantId: String, inventoryItemId: String, sku: String, title: String, image: String }],
      default: [],
    },
    shopifyPushed: { type: mongoose.Schema.Types.Mixed, default: {} }, // variantId → last quantity sent
    needsReview: { type: Boolean, default: false },
    reviewNote: { type: String, default: "" },
  },
  { timestamps: true }
);

itemSchema.index({ organization: 1, shopifyVariantId: 1 });
itemSchema.index({ organization: 1, "shopifyLinks.variantId": 1 });
module.exports = mongoose.model("Item", itemSchema);
