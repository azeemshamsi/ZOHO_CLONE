const mongoose = require("mongoose");

/**
 * A broadcast: a WhatsApp marketing template or an email to an audience of customers / store-order buyers.
 * audience: { source: orders|customers|both, lastDays, notSinceDays, states[], cities[], skus[], products[],
 *             payment: cod|prepaid|"", minOrders, maxOrders, minSpend, maxSpend, tags[] }
 */
const campaignSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true },
    name: { type: String, required: true, trim: true },
    channel: { type: String, enum: ["whatsapp", "email"], required: true },
    audience: { type: mongoose.Schema.Types.Mixed, default: {} },
    whatsapp: { template: String, language: String, params: [String], headerParam: String, headerMediaUrl: String },
    email: { subject: String, body: String }, // body: plain text with {{name}}; sent as text + simple HTML
    status: { type: String, enum: ["draft", "scheduled", "running", "paused", "done", "cancelled", "failed"], default: "draft" },
    scheduledAt: Date,
    startedAt: Date,
    finishedAt: Date,
    ratePerMinute: { type: Number, default: 60 },
    totals: { recipients: { type: Number, default: 0 }, sent: { type: Number, default: 0 }, delivered: { type: Number, default: 0 }, read: { type: Number, default: 0 }, failed: { type: Number, default: 0 }, replied: { type: Number, default: 0 }, skipped: { type: Number, default: 0 } },
    error: { type: String, default: "" },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    createdByName: String,
    testSentAt: Date,
  },
  { timestamps: true, minimize: false }
);
campaignSchema.index({ organization: 1, createdAt: -1 });

module.exports = mongoose.model("Campaign", campaignSchema);
