const mongoose = require("mongoose");

// "If a statement line looks like this, record it like that."
const conditionSchema = new mongoose.Schema(
  {
    field: { type: String, enum: ["description", "reference", "amount"], required: true },
    op: {
      type: String,
      enum: ["contains", "not_contains", "equals", "starts_with", "ends_with", "greater_than", "less_than"],
      required: true,
    },
    value: { type: String, required: true },
  },
  { _id: false }
);

const bankRuleSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    name: { type: String, required: true, trim: true },
    applyTo: { type: String, enum: ["withdrawals", "deposits"], required: true },
    accounts: { type: [String], default: [] }, // bank/cash account codes; empty = every account
    match: { type: String, enum: ["any", "all"], default: "any" },
    conditions: { type: [conditionSchema], default: [] },
    // What to do: record against this account (expense account → Expense, anything else → Journal).
    account: { type: String, required: true },
    taxRate: { type: Number, default: 0 },
    notes: { type: String, default: "" },
    priority: { type: Number, default: 0 }, // lower = applied first
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("BankRule", bankRuleSchema);
