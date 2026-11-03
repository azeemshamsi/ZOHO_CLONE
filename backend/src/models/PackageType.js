const mongoose = require("mongoose");

// A box/packing a product ships in: its packed weight and size. Assigned to items, or chosen when booking.
const packageTypeSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    name: { type: String, required: true, trim: true },
    weight: { type: Number, required: true }, // kg, packed
    length: { type: Number, required: true }, // cm
    breadth: { type: Number, required: true },
    height: { type: Number, required: true },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("PackageType", packageTypeSchema);
