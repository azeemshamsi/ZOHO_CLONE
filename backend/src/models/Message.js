const mongoose = require("mongoose");

// One message in an Inbox conversation (in from the customer, out from us, or an internal note).
const messageSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true },
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: "Conversation", required: true },
    direction: { type: String, enum: ["in", "out"], required: true },
    kind: { type: String, enum: ["text", "image", "video", "audio", "document", "template", "comment", "email", "note", "button", "sticker", "location", "other"], default: "text" },
    text: { type: String, default: "" },
    html: { type: String, default: "" },
    media: [{ _id: false, url: String, mime: String, name: String, size: Number, fileId: mongoose.Schema.Types.ObjectId, externalId: String }],
    externalId: { type: String, default: "" }, // wamid / mid / comment id / Gmail message id
    replyTo: { type: String, default: "" }, // external id of the message this replies to
    status: { type: String, enum: ["queued", "sent", "delivered", "read", "failed", "received"], default: "received" },
    error: { type: String, default: "" },
    by: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    byName: { type: String, default: "" }, // "Auto-reply", "AI (approved by …)", a user's name
    auto: { type: String, default: "" }, // rule | away | order_status | ai | order_update | campaign
    meta: { type: mongoose.Schema.Types.Mixed }, // template {name, language}, email {messageId, references, from, to, cc, subject}, comment {hidden, privateReplied}
    at: { type: Date, default: Date.now },
  },
  { timestamps: true }
);
messageSchema.index({ organization: 1, conversation: 1, at: 1 });
messageSchema.index({ organization: 1, externalId: 1 });
messageSchema.index({ at: 1 });

module.exports = mongoose.model("Message", messageSchema);
