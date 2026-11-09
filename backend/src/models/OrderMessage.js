const mongoose = require("mongoose");

// WhatsApp order updates sent (or skipped) for a store order: one row per order and event.
const orderMessageSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true }, // the company that sent it
    order: { type: mongoose.Schema.Types.ObjectId, ref: "ShopifyOrder", required: true },
    orderName: String,
    event: { type: String, required: true },
    to: String,
    template: String,
    status: { type: String, enum: ["sent", "delivered", "read", "failed", "skipped", "replied"], default: "sent" },
    error: { type: String, default: "" },
    externalId: { type: String, default: "" },
    reply: { type: String, default: "" }, // COD confirmation: "confirmed" | "cancel_requested"
    at: { type: Date, default: Date.now },
  },
  { timestamps: true }
);
orderMessageSchema.index({ order: 1, event: 1 });
orderMessageSchema.index({ externalId: 1 });

module.exports = mongoose.model("OrderMessage", orderMessageSchema);
