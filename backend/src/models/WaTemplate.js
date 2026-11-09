const mongoose = require("mongoose");

// A WhatsApp message template of the company's WABA (synced from Meta; created and approved in WhatsApp Manager).
const waTemplateSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true },
    externalId: String,
    name: { type: String, required: true },
    language: { type: String, default: "en" },
    status: String, // APPROVED, PENDING, REJECTED, PAUSED, DISABLED
    category: String, // MARKETING, UTILITY, AUTHENTICATION
    components: { type: mongoose.Schema.Types.Mixed, default: [] },
    bodyParams: { type: Number, default: 0 },
    headerParams: { type: Number, default: 0 },
    headerFormat: String, // TEXT, IMAGE, VIDEO, DOCUMENT
    buttons: { type: mongoose.Schema.Types.Mixed, default: [] }, // [{ type: QUICK_REPLY|URL|PHONE_NUMBER, text, url }]
    syncedAt: Date,
  },
  { timestamps: true }
);
waTemplateSchema.index({ organization: 1, name: 1, language: 1 }, { unique: true });

module.exports = mongoose.model("WaTemplate", waTemplateSchema);
