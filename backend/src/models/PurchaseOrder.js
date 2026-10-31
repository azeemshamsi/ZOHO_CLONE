const mongoose = require("mongoose");
const { salesDocFields } = require("./shared");

const purchaseOrderSchema = new mongoose.Schema(
  {
    ...salesDocFields("vendor"),
    number: { type: String, required: true },
    reference: { type: String, default: "" },
    deliveryDate: { type: Date },
    status: { type: String, enum: ["draft", "issued", "billed", "cancelled"], default: "draft" },
    bill: { type: mongoose.Schema.Types.ObjectId, ref: "Bill" },
    billNumber: { type: String, default: "" },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

purchaseOrderSchema.index({ organization: 1, number: 1 }, { unique: true });
purchaseOrderSchema.virtual("displayStatus").get(function () {
  return this.status;
});

module.exports = mongoose.model("PurchaseOrder", purchaseOrderSchema);
