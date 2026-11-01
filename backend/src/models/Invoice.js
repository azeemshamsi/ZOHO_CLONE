const mongoose = require("mongoose");
const { salesDocFields, startOfToday } = require("./shared");

const invoiceSchema = new mongoose.Schema(
  {
    ...salesDocFields(),
    invoiceNumber: { type: String, required: true },
    orderNumber: { type: String, default: "" },
    dueDate: { type: Date, required: true },
    paymentTerms: { type: Number, default: 0 },
    amountPaid: { type: Number, default: 0 },
    creditsApplied: { type: Number, default: 0 },
    balance: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["draft", "sent", "partially_paid", "paid", "void"],
      default: "draft",
    },
    quote: { type: mongoose.Schema.Types.ObjectId, ref: "Quote" },
    salesOrder: { type: mongoose.Schema.Types.ObjectId, ref: "SalesOrder" },
    project: { type: mongoose.Schema.Types.ObjectId, ref: "Project" }, // invoiced from a project
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

invoiceSchema.index({ organization: 1, invoiceNumber: 1 }, { unique: true });

// Status shown to users: "overdue" is derived, not stored.
invoiceSchema.virtual("displayStatus").get(function () {
  if (["sent", "partially_paid"].includes(this.status) && this.balance > 0 && this.dueDate < startOfToday()) {
    return "overdue";
  }
  return this.status;
});

module.exports = mongoose.model("Invoice", invoiceSchema);
