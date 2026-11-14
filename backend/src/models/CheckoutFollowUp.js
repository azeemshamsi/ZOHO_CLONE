const mongoose = require("mongoose");

// Team follow-up on a Shopify abandoned checkout: remarks (what was said to the customer), a status and the
// next follow-up date. Kept in OrdexaGo (Shopify's API can't write checkout timeline comments).
const followUpSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    checkoutId: { type: String, required: true }, // Shopify numeric id
    customerKey: { type: String, default: "" }, // Shopify customer id, else last 10 phone digits, else email
    customer: { type: String, default: "" },
    phone: { type: String, default: "" },
    status: { type: String, default: "" },
    nextOn: { type: Date, default: null },
    notes: [
      {
        text: String,
        status: String, // status set with this remark
        by: String,
        byId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        at: Date,
      },
    ],
    lastAt: { type: Date, default: null },
    orderName: { type: String, default: "" }, // order created from this checkout in OrdexaGo
  },
  { timestamps: true }
);
followUpSchema.index({ organization: 1, checkoutId: 1 }, { unique: true });
module.exports = mongoose.model("CheckoutFollowUp", followUpSchema);
