const mongoose = require("mongoose");

const EXPENSE_CATEGORIES = [
  "Advertising & Marketing",
  "Bank Fees & Charges",
  "Courier & Shipping",
  "Fuel & Conveyance",
  "Internet & Telephone",
  "IT & Software",
  "Meals & Entertainment",
  "Office Supplies",
  "Packaging Materials",
  "Professional Fees",
  "Raw Materials",
  "Rent",
  "Repairs & Maintenance",
  "Salaries & Wages",
  "Travel",
  "Utilities",
  "Other Expenses",
];

const expenseSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    date: { type: Date, required: true },
    category: { type: String, required: true },
    amount: { type: Number, required: true }, // before GST
    taxRate: { type: Number, default: 0 },
    placeOfSupply: { type: String, default: "" }, // where the supply came from
    isInterState: { type: Boolean, default: false },
    cgst: { type: Number, default: 0 },
    sgst: { type: Number, default: 0 },
    igst: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    vendor: { type: mongoose.Schema.Types.ObjectId, ref: "Vendor" },
    vendorName: { type: String, default: "" },
    paidThrough: {
      type: String,
      enum: ["cash", "bank_transfer", "upi", "cheque", "card", "other"],
      default: "bank_transfer",
    },
    reference: { type: String, default: "" },
    notes: { type: String, default: "" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Expense", expenseSchema);
module.exports.EXPENSE_CATEGORIES = EXPENSE_CATEGORIES;
