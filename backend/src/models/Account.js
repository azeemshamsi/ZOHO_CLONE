const mongoose = require("mongoose");

// Account types a user can create, and which side of the books each sits on.
const ACCOUNT_TYPES = {
  Cash: "asset",
  Bank: "asset",
  "Other Current Asset": "asset",
  "Fixed Asset": "asset",
  "Other Current Liability": "liability",
  "Long Term Liability": "liability",
  Equity: "equity",
  Income: "income",
  "Other Income": "income",
  "Cost Of Goods Sold": "expense",
  Expense: "expense",
  "Other Expense": "expense",
};

// User-created accounts. Built-in accounts live in utils/ledger.js.
const accountSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    name: { type: String, required: true, trim: true },
    group: { type: String, enum: Object.keys(ACCOUNT_TYPES), required: true },
    accountCode: { type: String, default: "" },
    description: { type: String, default: "" },
    active: { type: Boolean, default: true },
    // Sales / purchase ledger (as in Tally): offered on invoices and credit notes / bills and vendor credits.
    ledgerKind: { type: String, enum: ["", "sales", "purchase"], default: "" },
    // Purchases posted here are non-GST supplies (petrol, diesel, liquor…): GSTR-3B Table 5 "Non GST supply".
    nonGst: { type: Boolean, default: false },
    // "opening_stock_diff": Tally's Opening Stock ledger minus its items' opening values (shown as Opening Stock in the Tally view)
    role: { type: String, default: "" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Account", accountSchema);
module.exports.ACCOUNT_TYPES = ACCOUNT_TYPES;
