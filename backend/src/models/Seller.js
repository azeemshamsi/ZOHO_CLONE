const mongoose = require("mongoose");

// A marketplace seller (brand) on the Shopify store. Their products are found by the Shopify product "Vendor".
// We buy from them at `rate`% of the sale price (GST included, before our discounts) for delivered orders.
const sellerSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true }, // the store's company
    name: { type: String, required: true, trim: true },
    brands: { type: [String], default: [] }, // Shopify Vendor values (case-insensitive)
    contactName: { type: String, default: "" },
    email: { type: String, default: "", lowercase: true, trim: true },
    phone: { type: String, default: "" },
    gstin: { type: String, default: "", uppercase: true, trim: true },
    pan: { type: String, default: "", uppercase: true, trim: true },
    rate: { type: Number, required: true, min: 0, max: 100 }, // purchase price % of sale value
    poFrom: { type: Date }, // only orders delivered on/after this date go on purchase orders (earlier ones were settled outside)
    pickup: {
      name: { type: String, default: "" },
      phone: { type: String, default: "" },
      address: { type: String, default: "" },
      city: { type: String, default: "" },
      state: { type: String, default: "" }, // GST state code
      pincode: { type: String, default: "" },
    },
    // Per courier account: the pickup registered with the courier (Delhivery warehouse name, Shiprocket pickup nickname)
    // or codes Blue Dart gave for this location. { [accountId]: { pickupLocation, originArea, customerCode, vendorCode, status, error, at } }
    couriers: { type: mongoose.Schema.Types.Mixed, default: {} },
    // The accounting vendor for this seller in each company that raises purchase orders: { [orgId]: vendorId }
    vendors: { type: mongoose.Schema.Types.Mixed, default: {} },
    active: { type: Boolean, default: true },
    notes: { type: String, default: "" },
  },
  { timestamps: true, minimize: false }
);
module.exports = mongoose.model("Seller", sellerSchema);
