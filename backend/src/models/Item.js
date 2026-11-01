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
    reorderLevel: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Item", itemSchema);
