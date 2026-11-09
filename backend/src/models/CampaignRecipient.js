const mongoose = require("mongoose");

// One person a campaign goes to, with their delivery status.
const recipientSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true },
    campaign: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign", required: true },
    to: { type: String, required: true }, // WhatsApp number (digits with country code) or email
    name: { type: String, default: "" },
    vars: { type: mongoose.Schema.Types.Mixed, default: {} },
    status: { type: String, enum: ["queued", "sent", "delivered", "read", "failed", "replied", "skipped"], default: "queued" },
    error: { type: String, default: "" },
    externalId: { type: String, default: "" },
    attempts: { type: Number, default: 0 },
    nextTryAt: Date,
    sentAt: Date,
  },
  { timestamps: true }
);
recipientSchema.index({ campaign: 1, status: 1 });
recipientSchema.index({ externalId: 1 });

module.exports = mongoose.model("CampaignRecipient", recipientSchema);
