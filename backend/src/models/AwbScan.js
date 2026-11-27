const mongoose = require("mongoose");

// Every parcel scanned at handover (Store → Scan AWB): orders in OrdexaGo and AWBs that aren't (Amazon, Flipkart,
// Pepperfry… shipped outside it), so any AWB can be looked up later — was it scanned, when and by whom.
const awbScanSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true },
    code: { type: String, required: true }, // as scanned, upper-case
    at: { type: Date, default: Date.now },
    by: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    byName: { type: String, default: "" },
    order: { type: mongoose.Schema.Types.ObjectId, ref: "ShopifyOrder" },
    orderName: { type: String, default: "" },
    channel: { type: String, default: "" }, // shopify / amazon / flipkart / pepperfry / other
    courier: { type: String, default: "" },
    matched: { type: Boolean, default: false }, // found an order in OrdexaGo
  },
  { timestamps: true },
);
awbScanSchema.index({ organization: 1, code: 1 });
awbScanSchema.index({ organization: 1, at: -1 });

module.exports = mongoose.model("AwbScan", awbScanSchema);
