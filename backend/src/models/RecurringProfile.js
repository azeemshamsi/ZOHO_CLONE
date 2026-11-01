const mongoose = require("mongoose");

// A schedule that creates an invoice, bill or expense on repeat.
const recurringSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    kind: { type: String, enum: ["invoice", "bill", "expense"], required: true },
    name: { type: String, required: true, trim: true },
    every: { type: Number, default: 1, min: 1 },
    unit: { type: String, enum: ["day", "week", "month", "year"], default: "month" },
    startDate: { type: Date, required: true },
    endDate: { type: Date }, // empty = never expires
    occurrences: { type: Number, default: 0 }, // how many have been created
    nextDate: { type: Date },
    status: { type: String, enum: ["active", "stopped", "expired"], default: "active" },
    paymentTerms: { type: Number, default: 0 }, // due date = date + terms (invoices and bills)
    createAs: { type: String, enum: ["draft", "final"], default: "final" }, // invoices: draft or sent; bills: draft or open
    template: { type: mongoose.Schema.Types.Mixed, required: true }, // body for the create API, without dates
    partyName: { type: String, default: "" },
    amount: { type: Number, default: 0 }, // total of one occurrence, for the list
    history: [{ _id: false, id: mongoose.Schema.Types.ObjectId, number: String, date: Date, total: Number }],
    lastError: { type: String, default: "" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("RecurringProfile", recurringSchema);
