const mongoose = require("mongoose");

// Canned responses for the Inbox reply box ("/shortcut" or the quick-replies menu).
const quickReplySchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    title: { type: String, required: true, trim: true },
    shortcut: { type: String, default: "", trim: true },
    text: { type: String, required: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("QuickReply", quickReplySchema);
