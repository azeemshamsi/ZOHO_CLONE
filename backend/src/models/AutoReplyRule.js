const mongoose = require("mongoose");

// Keyword auto-reply: when a message on one of `channels` matches, reply with text or a WhatsApp template.
const ruleSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    name: { type: String, required: true, trim: true },
    active: { type: Boolean, default: true },
    channels: { type: [String], default: ["whatsapp", "messenger", "instagram"] },
    match: { type: String, enum: ["contains", "exact"], default: "contains" },
    keywords: { type: [String], default: [] },
    hours: { type: String, enum: ["any", "open", "closed"], default: "any" }, // business hours
    reply: { kind: { type: String, enum: ["text", "template"], default: "text" }, text: String, template: String, language: String },
    position: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("AutoReplyRule", ruleSchema);
