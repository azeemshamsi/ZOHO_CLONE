const mongoose = require("mongoose");

// Per-organization running numbers for invoices, payments, etc.
const counterSchema = new mongoose.Schema({
  organization: { type: mongoose.Schema.Types.ObjectId, required: true },
  key: { type: String, required: true },
  seq: { type: Number, default: 0 },
});
counterSchema.index({ organization: 1, key: 1 }, { unique: true });

const Counter = mongoose.model("Counter", counterSchema);

async function nextNumber(organization, key, prefix, width = 6) {
  const doc = await Counter.findOneAndUpdate(
    { organization, key },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return `${prefix}${String(doc.seq).padStart(width, "0")}`;
}

module.exports = { Counter, nextNumber };
