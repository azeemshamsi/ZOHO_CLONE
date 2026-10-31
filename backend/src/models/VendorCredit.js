const mongoose = require("mongoose");
const { salesDocFields } = require("./shared");

// Credit a vendor gives you (returns, discounts, billing corrections).
const vendorCreditSchema = new mongoose.Schema(
  {
    ...salesDocFields("vendor"),
    number: { type: String, required: true },
    reference: { type: String, default: "" },
    bill: { type: mongoose.Schema.Types.ObjectId, ref: "Bill" },
    billNumber: { type: String, default: "" },
    reason: { type: String, default: "" },
    status: { type: String, enum: ["draft", "open", "closed", "void"], default: "draft" },
    balance: { type: Number, default: 0 },
    applications: {
      type: [
        new mongoose.Schema({
          bill: { type: mongoose.Schema.Types.ObjectId, ref: "Bill", required: true },
          billNumber: { type: String, default: "" },
          amount: { type: Number, required: true },
          date: { type: Date, default: Date.now },
        }),
      ],
      default: [],
    },
    // Money the vendor paid back to you.
    refunds: {
      type: [
        new mongoose.Schema({
          date: { type: Date, required: true },
          amount: { type: Number, required: true },
          mode: { type: String, default: "bank_transfer" },
          bankAccount: { type: String, default: "" },
          reference: { type: String, default: "" },
        }),
      ],
      default: [],
    },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

vendorCreditSchema.index({ organization: 1, number: 1 }, { unique: true });
vendorCreditSchema.virtual("displayStatus").get(function () {
  return this.status;
});

module.exports = mongoose.model("VendorCredit", vendorCreditSchema);
