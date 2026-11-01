const mongoose = require("mongoose");
const { addressSchema } = require("./Organization");

// A branch / business location with its own GSTIN and address. Documents without a branch belong to the head office.
const branchSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    name: { type: String, required: true, trim: true },
    code: { type: String, default: "" },
    gstin: { type: String, default: "", uppercase: true, trim: true },
    state: { type: String, required: true },
    address: { type: addressSchema, default: () => ({}) },
    email: { type: String, default: "" },
    phone: { type: String, default: "" },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);
module.exports = mongoose.model("Branch", branchSchema);
