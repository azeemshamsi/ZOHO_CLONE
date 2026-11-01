const mongoose = require("mongoose");

// A rack / bin inside a warehouse. Stock is put away into racks; the books only see warehouses.
const rackSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    warehouse: { type: mongoose.Schema.Types.ObjectId, ref: "Warehouse", default: null }, // null = primary
    code: { type: String, required: true, trim: true, uppercase: true },
    name: { type: String, default: "" },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);
rackSchema.index({ organization: 1, warehouse: 1, code: 1 }, { unique: true });
module.exports = mongoose.model("Rack", rackSchema);
