const mongoose = require("mongoose");

// A penalty charged to a marketplace seller: reduces the next monthly purchase order (as a negative adjustment).
const penaltySchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true }, // store's company
    seller: { type: mongoose.Schema.Types.ObjectId, ref: "Seller", required: true, index: true },
    date: { type: Date, required: true },
    amount: { type: Number, required: true, min: 0.01 },
    reason: { type: String, required: true, trim: true },
    order: { type: mongoose.Schema.Types.ObjectId, ref: "ShopifyOrder" },
    orderName: { type: String, default: "" },
    purchaseOrder: { type: mongoose.Schema.Types.ObjectId, ref: "PurchaseOrder" }, // set once deducted
    purchaseOrderNumber: { type: String, default: "" },
    purchaseOrderOrg: { type: mongoose.Schema.Types.ObjectId, ref: "Organization" },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);
module.exports = mongoose.model("SellerPenalty", penaltySchema);
