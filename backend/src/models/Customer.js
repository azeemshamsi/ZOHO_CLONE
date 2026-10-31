const mongoose = require("mongoose");
const { addressSchema } = require("./Organization");

const customerSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    customerType: { type: String, enum: ["business", "individual"], default: "business" },
    displayName: { type: String, required: true, trim: true },
    companyName: { type: String, default: "" },
    firstName: { type: String, default: "" },
    lastName: { type: String, default: "" },
    email: { type: String, default: "" },
    phone: { type: String, default: "" },
    gstTreatment: {
      type: String,
      enum: ["registered", "unregistered", "consumer", "overseas", "sez"],
      default: "consumer",
    },
    gstin: { type: String, default: "", uppercase: true, trim: true },
    placeOfSupply: { type: String, default: "" }, // GST state code
    billingAddress: { type: addressSchema, default: () => ({}) },
    shippingAddress: { type: addressSchema, default: () => ({}) },
    paymentTerms: { type: Number, default: 15 }, // days
    notes: { type: String, default: "" },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Customer", customerSchema);
