const mongoose = require("mongoose");
const { salesDocFields } = require("./shared");

const applicationSchema = new mongoose.Schema(
  {
    invoice: { type: mongoose.Schema.Types.ObjectId, ref: "Invoice", required: true },
    invoiceNumber: { type: String, default: "" },
    amount: { type: Number, required: true },
    date: { type: Date, default: Date.now },
  },
  { _id: true }
);

const refundSchema = new mongoose.Schema(
  {
    date: { type: Date, required: true },
    amount: { type: Number, required: true },
    mode: { type: String, default: "bank_transfer" },
    bankAccount: { type: String, default: "" },
    reference: { type: String, default: "" },
  },
  { _id: true }
);

const creditNoteSchema = new mongoose.Schema(
  {
    ...salesDocFields(),
    // GST e-invoice details returned by the IRP
    einvoice: {
      status: { type: String, enum: ["none", "generated", "cancelled"], default: "none" },
      irn: { type: String, default: "" },
      ackNo: { type: String, default: "" },
      ackDate: { type: Date },
      signedQr: { type: String, default: "" },
      cancelReason: { type: String, default: "" },
      cancelledAt: { type: Date },
    },
    number: { type: String, required: true },
    reference: { type: String, default: "" },
    invoice: { type: mongoose.Schema.Types.ObjectId, ref: "Invoice" },
    invoiceNumber: { type: String, default: "" },
    reason: { type: String, default: "" },
    status: { type: String, enum: ["draft", "open", "closed", "void"], default: "draft" },
    balance: { type: Number, default: 0 }, // credit still available
    applications: { type: [applicationSchema], default: [] },
    refunds: { type: [refundSchema], default: [] },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

creditNoteSchema.index({ organization: 1, number: 1 }, { unique: true });

creditNoteSchema.virtual("displayStatus").get(function () {
  return this.status;
});

module.exports = mongoose.model("CreditNote", creditNoteSchema);
