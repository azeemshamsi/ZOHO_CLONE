const mongoose = require("mongoose");

// A saved bank reconciliation: on `asOf`, the bank said X and the books said Y.
const bankReconciliationSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    account: { type: String, required: true },
    asOf: { type: Date, required: true },
    statementBalance: { type: Number, required: true },
    bookBalance: { type: Number, required: true },
    unclearedInBooks: { type: Number, default: 0 }, // book entries not yet on the statement (net)
    notInBooks: { type: Number, default: 0 }, // statement lines not yet in the books (net)
    difference: { type: Number, default: 0 }, // unexplained; 0 = reconciled
    notes: { type: String, default: "" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("BankReconciliation", bankReconciliationSchema);
