const mongoose = require("mongoose");

const addressSchema = new mongoose.Schema(
  {
    street: { type: String, default: "" },
    city: { type: String, default: "" },
    state: { type: String, default: "" }, // GST state code, e.g. "27"
    pincode: { type: String, default: "" },
    country: { type: String, default: "India" },
  },
  { _id: false }
);

const organizationSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    gstin: { type: String, default: "", uppercase: true, trim: true },
    state: { type: String, required: true }, // GST state code of the business
    address: { type: addressSchema, default: () => ({}) },
    email: { type: String, default: "" },
    phone: { type: String, default: "" },
    website: { type: String, default: "" },
    currency: { type: String, default: "INR" },
    invoicePrefix: { type: String, default: "INV-" },
    paymentPrefix: { type: String, default: "PAY-" },
    quotePrefix: { type: String, default: "QT-" },
    salesOrderPrefix: { type: String, default: "SO-" },
    creditNotePrefix: { type: String, default: "CN-" },
    vendorPaymentPrefix: { type: String, default: "PM-" },
    journalPrefix: { type: String, default: "MJ-" },
    defaultPaymentTerms: { type: Number, default: 15 },
    defaultNotes: { type: String, default: "Thanks for your business." },
    defaultTerms: { type: String, default: "" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Organization", organizationSchema);
module.exports.addressSchema = addressSchema;
