const mongoose = require("mongoose");
const { addressSchema } = require("./Organization");

// A stock location. Stock with no warehouse is in the primary warehouse.
const warehouseSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    name: { type: String, required: true, trim: true },
    branch: { type: mongoose.Schema.Types.ObjectId, ref: "Branch" },
    address: { type: addressSchema, default: () => ({}) },
    primary: { type: Boolean, default: false },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);
module.exports = mongoose.model("Warehouse", warehouseSchema);
