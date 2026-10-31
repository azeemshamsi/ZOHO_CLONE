const mongoose = require("mongoose");
const { addressSchema } = require("./Organization");

const lineItemSchema = new mongoose.Schema(
  {
    item: { type: mongoose.Schema.Types.ObjectId, ref: "Item" },
    name: { type: String, required: true },
    description: { type: String, default: "" },
    hsnSac: { type: String, default: "" },
    unit: { type: String, default: "" },
    quantity: { type: Number, required: true },
    rate: { type: Number, required: true },
    discount: { type: Number, default: 0 }, // percent
    taxRate: { type: Number, default: 0 }, // GST percent
    amount: { type: Number, default: 0 }, // taxable value after discount
    cgst: { type: Number, default: 0 },
    sgst: { type: Number, default: 0 },
    igst: { type: Number, default: 0 },
  },
  { _id: false }
);

const invoiceSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true, index: true },
    customerName: { type: String, required: true },
    customerGstin: { type: String, default: "" },
    billingAddress: { type: addressSchema, default: () => ({}) },
    invoiceNumber: { type: String, required: true },
    orderNumber: { type: String, default: "" },
    date: { type: Date, required: true },
    dueDate: { type: Date, required: true },
    paymentTerms: { type: Number, default: 0 },
    placeOfSupply: { type: String, default: "" },
    isInterState: { type: Boolean, default: false },
    lineItems: { type: [lineItemSchema], default: [] },
    subTotal: { type: Number, default: 0 },
    cgst: { type: Number, default: 0 },
    sgst: { type: Number, default: 0 },
    igst: { type: Number, default: 0 },
    taxTotal: { type: Number, default: 0 },
    shippingCharge: { type: Number, default: 0 },
    adjustment: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    amountPaid: { type: Number, default: 0 },
    balance: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["draft", "sent", "partially_paid", "paid", "void"],
      default: "draft",
    },
    customerNotes: { type: String, default: "" },
    terms: { type: String, default: "" },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

invoiceSchema.index({ organization: 1, invoiceNumber: 1 }, { unique: true });

// Status shown to users: "overdue" is derived, not stored.
invoiceSchema.virtual("displayStatus").get(function () {
  if (["sent", "partially_paid"].includes(this.status) && this.balance > 0) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (this.dueDate < today) return "overdue";
  }
  return this.status;
});

module.exports = mongoose.model("Invoice", invoiceSchema);
