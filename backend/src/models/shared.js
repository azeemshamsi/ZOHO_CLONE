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

// Fields every sales (party = "customer") or purchase (party = "vendor") document shares.
const salesDocFields = (party = "customer") => ({
  organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
  [party]: { type: mongoose.Schema.Types.ObjectId, ref: party === "vendor" ? "Vendor" : "Customer", required: true, index: true },
  [`${party}Name`]: { type: String, required: true },
  branch: { type: mongoose.Schema.Types.ObjectId, ref: "Branch" },
  currency: { type: String, default: "INR" },
  opening: { type: Boolean, default: false }, // opening balance carried in from another system
  importRef: { type: String, index: true }, // set by the importer, to avoid importing twice
  exchangeRate: { type: Number, default: 1 }, // ₹ per 1 unit of currency
  warehouse: { type: mongoose.Schema.Types.ObjectId, ref: "Warehouse" },
  [`${party}Gstin`]: { type: String, default: "" },
  billingAddress: { type: addressSchema, default: () => ({}) },
  // Ship To (customer documents): where the goods go, if not the billing address.
  shipTo: {
    name: { type: String, default: "" },
    phone: { type: String, default: "" },
    street: { type: String, default: "" },
    city: { type: String, default: "" },
    state: { type: String, default: "" },
    pincode: { type: String, default: "" },
    country: { type: String, default: "" },
  },
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

// Today's date in India (see utils/time.js).
const startOfToday = () => require("../utils/time").istToday();

module.exports = { lineItemSchema, salesDocFields, startOfToday };
