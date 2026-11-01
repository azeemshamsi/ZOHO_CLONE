const mongoose = require("mongoose");

// Every email sent for a document (manual sends and automatic reminders).
const emailLogSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    kind: { type: String, required: true }, // invoice, quote, payment…
    docId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    type: { type: String, enum: ["document", "reminder", "receipt"], default: "document" },
    reminderDay: { type: Number }, // automatic reminders: days after due date
    to: [String],
    cc: [String],
    subject: String,
    sentBy: { type: String, default: "" }, // user name, or "Automatic"
  },
  { timestamps: true }
);

module.exports = mongoose.model("EmailLog", emailLogSchema);
