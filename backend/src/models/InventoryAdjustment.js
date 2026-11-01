const mongoose = require("mongoose");

// Change stock quantity (stocktake, damage, theft…) or stock value (revaluation).
const lineSchema = new mongoose.Schema(
  {
    item: { type: mongoose.Schema.Types.ObjectId, ref: "Item", required: true },
    name: { type: String, required: true },
    quantityAdjusted: { type: Number, default: 0 }, // + adds stock, − removes it (quantity mode)
    costPrice: { type: Number, default: 0 }, // cost per unit for stock added; 0 = current average
    valueAdjusted: { type: Number, default: 0 }, // value mode
  },
  { _id: false }
);

const adjustmentSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    number: { type: String, required: true },
    mode: { type: String, enum: ["quantity", "value"], default: "quantity" },
    date: { type: Date, required: true },
    reference: { type: String, default: "" },
    reason: { type: String, required: true },
    account: { type: String, default: "cogs" }, // the other side of the entry
    description: { type: String, default: "" },
    status: { type: String, enum: ["draft", "adjusted"], default: "adjusted" },
    lines: { type: [lineSchema], default: [] },
  },
  { timestamps: true }
);

adjustmentSchema.index({ organization: 1, number: 1 }, { unique: true });
module.exports = mongoose.model("InventoryAdjustment", adjustmentSchema);
module.exports.REASONS = ["Stocktaking results", "Damaged goods", "Stolen goods", "Stock on fire", "Stock written off", "Inventory revaluation", "Other"];
