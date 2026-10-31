const mongoose = require("mongoose");
const { addressSchema } = require("./Organization");

// One line on a quote, sales order, invoice or credit note.
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

// Fields every sales document shares.
const salesDocFields = () => ({
  organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
  customer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true, index: true },
  customerName: { type: String, required: true },
  customerGstin: { type: String, default: "" },
  billingAddress: { type: addressSchema, default: () => ({}) },
  date: { type: Date, required: true },
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
  customerNotes: { type: String, default: "" },
  terms: { type: String, default: "" },
});

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

module.exports = { lineItemSchema, salesDocFields, startOfToday };
