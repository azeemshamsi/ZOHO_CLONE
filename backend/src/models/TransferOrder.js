const mongoose = require("mongoose");

// Move stock between warehouses (no change in value).
const transferSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    number: { type: String, required: true },
    date: { type: Date, required: true },
    from: { type: mongoose.Schema.Types.ObjectId, ref: "Warehouse", required: true },
    to: { type: mongoose.Schema.Types.ObjectId, ref: "Warehouse", required: true },
    reason: { type: String, default: "" },
    status: { type: String, enum: ["draft", "transferred"], default: "transferred" },
    lines: [{ _id: false, item: { type: mongoose.Schema.Types.ObjectId, ref: "Item", required: true }, name: String, quantity: { type: Number, required: true } }],
  },
  { timestamps: true }
);
transferSchema.index({ organization: 1, number: 1 }, { unique: true });
module.exports = mongoose.model("TransferOrder", transferSchema);
