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
    // Own number series per document type (blank = the organization's series), e.g. { invoice: "DL-INV-" }
    prefixes: {
      invoice: { type: String, default: "" },
      creditNote: { type: String, default: "" },
      quote: { type: String, default: "" },
      salesOrder: { type: String, default: "" },
      payment: { type: String, default: "" },
      purchaseOrder: { type: String, default: "" },
      vendorCredit: { type: String, default: "" },
      vendorPayment: { type: String, default: "" },
    },
  },
  { timestamps: true }
);
module.exports = mongoose.model("Branch", branchSchema);
