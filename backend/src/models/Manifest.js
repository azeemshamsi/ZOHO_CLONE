const mongoose = require("mongoose");

// A handover manifest: the parcels given to a courier's pickup executive, printed for signature (Store → Manifests).
const rowSchema = new mongoose.Schema(
  {
    awb: { type: String, required: true },
    order: { type: mongoose.Schema.Types.ObjectId, ref: "ShopifyOrder" },
    orderName: { type: String, default: "" },
    channel: { type: String, default: "" }, // Shopify / Amazon / Flipkart / Pepperfry / Other
    courier: { type: String, default: "" },
    at: Date, // when the parcel was booked / scanned
    box: String, // "2 of 3" for an order in several boxes
  },
  { _id: false },
);
const manifestSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true },
    number: { type: String, required: true },
    courier: { type: String, default: "" }, // one courier, or "Multiple"
    channel: { type: String, default: "" },
    note: { type: String, default: "" },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    createdByName: { type: String, default: "" },
    rows: [rowSchema],
    count: { type: Number, default: 0 },
  },
  { timestamps: true },
);
manifestSchema.index({ organization: 1, createdAt: -1 });

module.exports = mongoose.model("Manifest", manifestSchema);
