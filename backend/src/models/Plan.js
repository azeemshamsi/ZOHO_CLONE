const mongoose = require("mongoose");

// A subscription plan the superadmin sells. A limit left empty (null) means unlimited.
const planSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    price: { type: Number, default: 0 }, // ₹ per period
    period: { type: String, enum: ["monthly", "quarterly", "half_yearly", "yearly"], default: "yearly" },
    maxCompanies: { type: Number, default: null },
    maxUsers: { type: Number, default: null },
    maxShopifyStores: { type: Number, default: null },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);
module.exports = mongoose.model("Plan", planSchema);
