const mongoose = require("mongoose");

const allocationSchema = new mongoose.Schema(
  {
    bill: { type: mongoose.Schema.Types.ObjectId, ref: "Bill", required: true },
    billNumber: { type: String, default: "" },
    amount: { type: Number, required: true },
  },
  { _id: false }
);

// "Payments Made": money paid to a vendor, applied to their bills.
const vendorPaymentSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    branch: { type: mongoose.Schema.Types.ObjectId, ref: "Branch" },
    importRef: { type: String, index: true },
    currency: { type: String, default: "INR" },
    exchangeRate: { type: Number, default: 1 },
    vendor: { type: mongoose.Schema.Types.ObjectId, ref: "Vendor", required: true, index: true },
    vendorName: { type: String, required: true },
    paymentNumber: { type: String, required: true },
    date: { type: Date, required: true },
    amount: { type: Number, required: true },
    mode: {
      type: String,
      enum: ["cash", "bank_transfer", "upi", "cheque", "card", "other"],
      default: "bank_transfer",
    },
    reference: { type: String, default: "" },
    bankAccount: { type: String, default: "" }, // cash/bank account code; blank = by payment mode
    notes: { type: String, default: "" },
    allocations: { type: [allocationSchema], default: [] },
    unusedAmount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("VendorPayment", vendorPaymentSchema);
