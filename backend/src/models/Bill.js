const mongoose = require("mongoose");
const { salesDocFields, startOfToday } = require("./shared");

const billSchema = new mongoose.Schema(
  {
    ...salesDocFields("vendor"),
    billNumber: { type: String, required: true }, // the vendor's own bill number
    orderNumber: { type: String, default: "" },
    dueDate: { type: Date, required: true },
    paymentTerms: { type: Number, default: 0 },
    amountPaid: { type: Number, default: 0 },
    creditsApplied: { type: Number, default: 0 },
    // Paid outside bill-wise allocation (journal, debit note, marketplace settlement) — matched from the supplier's
    // ledger balance (Bills → Match to ledger). No entry of its own; undo sets it back to 0.
    settledInLedger: { type: Number, default: 0 },
    balance: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["draft", "open", "partially_paid", "paid", "void"],
      default: "draft",
    },
    purchaseOrder: { type: mongoose.Schema.Types.ObjectId, ref: "PurchaseOrder" },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

billSchema.virtual("displayStatus").get(function () {
  if (["open", "partially_paid"].includes(this.status) && this.balance > 0 && this.dueDate < startOfToday()) {
    return "overdue";
  }
  return this.status;
});

module.exports = mongoose.model("Bill", billSchema);
