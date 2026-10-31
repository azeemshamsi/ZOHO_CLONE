const mongoose = require("mongoose");
const { addressSchema } = require("./Organization");

const vendorSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    displayName: { type: String, required: true, trim: true },
    companyName: { type: String, default: "" },
    firstName: { type: String, default: "" },
    lastName: { type: String, default: "" },
    email: { type: String, default: "" },
    phone: { type: String, default: "" },
    gstTreatment: {
      type: String,
      enum: ["registered", "unregistered", "consumer", "overseas", "sez"],
      default: "registered",
    },
    gstin: { type: String, default: "", uppercase: true, trim: true },
    pan: { type: String, default: "", uppercase: true, trim: true },
    placeOfSupply: { type: String, default: "" }, // "Source of supply": vendor's GST state code
    billingAddress: { type: addressSchema, default: () => ({}) },
    paymentTerms: { type: Number, default: 30 },
    notes: { type: String, default: "" },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Vendor", vendorSchema);
