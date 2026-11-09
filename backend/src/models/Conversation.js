const mongoose = require("mongoose");

/**
 * One customer thread in the Inbox: a WhatsApp chat, a Messenger / Instagram DM thread, the comments of one
 * person on one Facebook / Instagram post, or one email thread.
 * externalId: whatsapp → the customer's wa_id; messenger / instagram → their page/IG-scoped id;
 *             fb_comment / ig_comment → "<post or media id>:<commenter id>"; email → Gmail thread id.
 */
const CHANNELS = ["whatsapp", "messenger", "instagram", "fb_comment", "ig_comment", "email"];
const conversationSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true },
    channel: { type: String, enum: CHANNELS, required: true },
    externalId: { type: String, required: true },
    contact: { name: String, phone: String, email: String, handle: String, avatar: String, externalId: String },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer" },
    status: { type: String, enum: ["open", "pending", "closed"], default: "open" },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    unread: { type: Number, default: 0 },
    lastMessageAt: Date,
    lastMessagePreview: { type: String, default: "" },
    lastInboundAt: Date,
    windowEndsAt: Date, // WhatsApp / Messenger / Instagram: free-form replies allowed until then (24 h after their last message)
    tags: { type: [String], default: [] },
    // Comments: the post / media; email: subject and the latest message's headers for threading.
    post: { id: String, permalink: String, thumbnail: String, caption: String },
    subject: String,
    lastAutoReplyAt: Date,
    humanRepliedAt: Date,
    aiDraft: { text: String, at: Date, by: String },
  },
  { timestamps: true }
);
conversationSchema.index({ organization: 1, channel: 1, externalId: 1 }, { unique: true });
conversationSchema.index({ organization: 1, lastMessageAt: -1 });

module.exports = mongoose.model("Conversation", conversationSchema);
module.exports.CHANNELS = CHANNELS;
