const mongoose = require("mongoose");

const allocationSchema = new mongoose.Schema(
  {
    invoice: { type: mongoose.Schema.Types.ObjectId, ref: "Invoice", required: true },
    invoiceNumber: { type: String, default: "" },
    amount: { type: Number, required: true },
  },
  { _id: false }
);

const paymentSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true, index: true },
    customerName: { type: String, required: true },
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

module.exports = mongoose.model("Payment", paymentSchema);
