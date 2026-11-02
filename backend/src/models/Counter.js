const mongoose = require("mongoose");

// Per-organization running numbers for invoices, payments, etc.
const counterSchema = new mongoose.Schema({
  organization: { type: mongoose.Schema.Types.ObjectId, required: true },
  key: { type: String, required: true },
  seq: { type: Number, default: 0 },
});
counterSchema.index({ organization: 1, key: 1 }, { unique: true });

const Counter = mongoose.model("Counter", counterSchema);

// Numbers are padded to 2 digits: INV-01 … INV-09, INV-10, INV-123.
async function nextNumber(organization, key, prefix, width = 2) {
  const doc = await Counter.findOneAndUpdate(
    { organization, key },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return `${prefix}${String(doc.seq).padStart(width, "0")}`;
}

module.exports = { Counter, nextNumber };
