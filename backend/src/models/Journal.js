const mongoose = require("mongoose");

const lineSchema = new mongoose.Schema(
  {
    account: { type: String, required: true }, // account code (built-in) or Account _id
    description: { type: String, default: "" },
    debit: { type: Number, default: 0 },
    credit: { type: Number, default: 0 },
  },
  { _id: false }
);

// Manual journal entry.
const journalSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    number: { type: String, required: true },
    date: { type: Date, required: true },
    reference: { type: String, default: "" },
    notes: { type: String, default: "" },
    lines: { type: [lineSchema], default: [] },
    total: { type: Number, default: 0 },
  },
  { timestamps: true }
);

journalSchema.index({ organization: 1, number: 1 }, { unique: true });

module.exports = mongoose.model("Journal", journalSchema);
