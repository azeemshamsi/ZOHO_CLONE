const mongoose = require("mongoose");

// A file attached to a transaction (bill PDF, receipt photo, contract…). The bytes are in GridFS.
const attachmentSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true },
    docType: { type: String, required: true }, // invoice, bill, expense, payment…
    docId: { type: mongoose.Schema.Types.ObjectId, required: true },
    name: { type: String, required: true },
    type: { type: String, default: "application/octet-stream" },
    size: { type: Number, default: 0 },
    fileId: { type: mongoose.Schema.Types.ObjectId, required: true },
    uploadedBy: { type: String, default: "" },
  },
  { timestamps: true }
);
attachmentSchema.index({ organization: 1, docType: 1, docId: 1 });
module.exports = mongoose.model("Attachment", attachmentSchema);
