const mongoose = require("mongoose");

// Shopify customers' marketing consent (email / SMS), synced from the store hourly. Keyed by the store's company.
const consentSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true },
    shopifyCustomerId: { type: String, required: true },
    email: { type: String, default: "" },
    phone10: { type: String, default: "" },
    emailState: { type: String, default: "" }, // SUBSCRIBED, NOT_SUBSCRIBED, UNSUBSCRIBED, PENDING, REDACTED, INVALID
    smsState: { type: String, default: "" },
    updatedAt: Date,
  },
  { timestamps: false }
);
consentSchema.index({ organization: 1, shopifyCustomerId: 1 }, { unique: true });

module.exports = mongoose.model("MarketingConsent", consentSchema);
