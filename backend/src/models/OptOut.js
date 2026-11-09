const mongoose = require("mongoose");

// Contacts who don't want messages from the company: WhatsApp "STOP", email unsubscribe links, or added by staff.
// value: the last 10 digits of a phone (whatsapp) or a lower-case email address (email).
const optOutSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true },
    channel: { type: String, enum: ["whatsapp", "email"], required: true },
    value: { type: String, required: true },
    source: { type: String, default: "" }, // stop_keyword, unsubscribe_link, staff, import
    note: { type: String, default: "" },
    at: { type: Date, default: Date.now },
  },
  { timestamps: true }
);
optOutSchema.index({ organization: 1, channel: 1, value: 1 }, { unique: true });

module.exports = mongoose.model("OptOut", optOutSchema);
