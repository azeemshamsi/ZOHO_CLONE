const mongoose = require("mongoose");
const { salesDocFields } = require("./shared");

const salesOrderSchema = new mongoose.Schema(
  {
    ...salesDocFields(),
    number: { type: String, required: true },
    reference: { type: String, default: "" },
    shipmentDate: { type: Date },
    status: {
      type: String,
      enum: ["draft", "confirmed", "invoiced", "cancelled"],
      default: "draft",
    },
    quote: { type: mongoose.Schema.Types.ObjectId, ref: "Quote" },
    quoteNumber: { type: String, default: "" },
    invoice: { type: mongoose.Schema.Types.ObjectId, ref: "Invoice" },
    invoiceNumber: { type: String, default: "" },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

salesOrderSchema.index({ organization: 1, number: 1 }, { unique: true });

salesOrderSchema.virtual("displayStatus").get(function () {
  return this.status;
});

module.exports = mongoose.model("SalesOrder", salesOrderSchema);
