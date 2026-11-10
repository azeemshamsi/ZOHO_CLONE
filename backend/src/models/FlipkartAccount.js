const mongoose = require("mongoose");

// A company's Flipkart seller account, connected through Flipkart's Seller API with a self-access application
// (Seller Hub → Manage Profile → Developer Access): App ID + App secret. Orders come into Store → Orders
// (channel "flipkart"); Flipkart's stock follows the Shopify stock of the same SKU. One per company.
const flipkartAccountSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, unique: true },
    name: { type: String, default: "Flipkart" },
    appId: { type: String, default: "" },
    appSecret: { type: String, default: "" },
    accessToken: { type: String, default: "" },
    tokenExpires: { type: Date },
    connected: { type: Boolean, default: false },
    locationId: { type: String, default: "" }, // the seller's Flipkart pickup location (from the orders; or set by hand)
    // Self-ship: the Flipkart delivery partner code to report for each of our couriers (carrier → {name, code}).
    selfShipPartners: { type: mongoose.Schema.Types.Mixed, default: {} },
    syncFrom: { type: Date },
    autoSync: { type: Boolean, default: true },
    lastSyncAt: { type: Date },
    sync: {
      running: { type: Boolean, default: false },
      startedAt: Date,
      finishedAt: Date,
      fetched: { type: Number, default: 0 },
      created: { type: Number, default: 0 },
      updated: { type: Number, default: 0 },
      error: { type: String, default: "" },
    },
    // Stock: Flipkart listings follow the Shopify stock of the same SKU (minus a buffer kept back).
    stockSync: { type: Boolean, default: true },
    stockBuffer: { type: Number, default: 0, min: 0 },
    // New Flipkart orders take their quantity off the Shopify stock (and cancellations before dispatch put it back).
    reduceShopify: { type: Boolean, default: true },
    reduceFrom: { type: Date }, // only orders placed from this time (set when connected; older ones are already counted)
    stock: {
      running: { type: Boolean, default: false },
      startedAt: Date,
      finishedAt: Date,
      listings: { type: Number, default: 0 }, // SKUs found on Flipkart
      updated: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
      error: { type: String, default: "" },
      errors: { type: [String], default: [] },
    },
    // SKU → { productId (FSN), locations: [id], pushed: last quantity sent, at }. Refreshed daily.
    listings: { type: mongoose.Schema.Types.Mixed, default: {} },
    listingsAt: { type: Date },
  },
  {
    timestamps: true,
    minimize: false,
    toJSON: {
      transform: (doc, ret) => {
        ret.hasSecret = Boolean(ret.appSecret);
        delete ret.appSecret;
        delete ret.accessToken;
        delete ret.tokenExpires;
        delete ret.listings;
        return ret;
      },
    },
  }
);

const { encryptFields, FIELDS } = require("../utils/secrets");
encryptFields(flipkartAccountSchema, FIELDS.FlipkartAccount);

module.exports = mongoose.model("FlipkartAccount", flipkartAccountSchema);
