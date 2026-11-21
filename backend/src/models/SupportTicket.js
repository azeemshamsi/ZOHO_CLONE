const mongoose = require("mongoose");

// A marketplace seller's support ticket (raised on their dashboard), handled by the team at Store → Tickets.
const fileSchema = new mongoose.Schema({ fileId: mongoose.Schema.Types.ObjectId, name: String, type: { type: String }, size: Number }, { _id: true });
const messageSchema = new mongoose.Schema(
  {
    from: { type: String, enum: ["seller", "team", "system"], required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    name: { type: String, default: "" },
    text: { type: String, default: "" },
    files: [fileSchema],
    internal: { type: Boolean, default: false }, // team-only note, never shown to the seller
    at: { type: Date, default: Date.now },
  },
  { _id: true }
);
const ticketSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true }, // the store's company
    number: { type: Number, required: true },
    seller: { type: mongoose.Schema.Types.ObjectId, ref: "Seller", required: true, index: true },
    sellerName: { type: String, default: "" },
    raisedBy: { user: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, name: String, email: String },
    category: { type: String, default: "other" },
    subject: { type: String, required: true },
    order: { type: mongoose.Schema.Types.ObjectId, ref: "ShopifyOrder" },
    orderName: { type: String, default: "" },
    priority: { type: String, enum: ["low", "normal", "high", "urgent"], default: "normal" },
    status: { type: String, enum: ["open", "in_progress", "waiting", "resolved", "closed"], default: "open", index: true },
    assignee: { user: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, name: String },
    messages: [messageSchema],
    lastActivityAt: { type: Date, default: Date.now },
    lastFrom: { type: String, default: "seller" },
    sellerUnread: { type: Number, default: 0 }, // team replies the seller hasn't opened
    teamUnread: { type: Number, default: 0 }, // seller messages the team hasn't opened
    firstResponseAt: Date,
    resolvedAt: Date,
    closedAt: Date,
  },
  { timestamps: true }
);
ticketSchema.index({ organization: 1, number: 1 }, { unique: true });
module.exports = mongoose.model("SupportTicket", ticketSchema);
