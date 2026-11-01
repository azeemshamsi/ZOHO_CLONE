const mongoose = require("mongoose");

// GST category rule used when Shopify products become MGI items.
const ruleSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    taxRate: { type: Number, required: true },
    defaultHsn: { type: String, default: "" },
    hsnPrefixes: { type: [String], default: [] }, // HSN codes that belong to this category (e.g. 9401, 9403)
    keywords: { type: [String], default: [] }, // matched against product type, Shopify category, tags and title
  },
  { _id: false }
);

// The connected Shopify store and how its orders are handled. One per organization.
const shopifyStoreSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, unique: true },
    shop: { type: String, default: "" }, // xxx.myshopify.com
    shopName: { type: String, default: "" },
    authType: { type: String, enum: ["client", "token"], default: "client" }, // Dev Dashboard app (client credentials) or a legacy admin token
    clientId: { type: String, default: "" },
    clientSecret: { type: String, default: "" },
    accessToken: { type: String, default: "" }, // legacy shpat_ token, or the cached client-credentials token
    tokenExpires: { type: Date },
    connected: { type: Boolean, default: false },
    // Sync
    syncFrom: { type: Date },
    autoSync: { type: Boolean, default: true },
    lastSyncAt: { type: Date }, // orders updated after this are fetched next time
    sync: {
      running: { type: Boolean, default: false },
      startedAt: Date,
      finishedAt: Date,
      fetched: { type: Number, default: 0 },
      created: { type: Number, default: 0 },
      updated: { type: Number, default: 0 },
      error: { type: String, default: "" },
    },
    // Invoicing
    invoice: {
      status: { type: String, enum: ["draft", "sent"], default: "sent" },
      dateFrom: { type: String, enum: ["order", "today"], default: "order" },
      recordPayment: { type: Boolean, default: false }, // prepaid (paid) orders get a payment received
      paymentAccount: { type: String, default: "" },
      branch: { type: mongoose.Schema.Types.ObjectId, ref: "Branch" },
      warehouse: { type: mongoose.Schema.Types.ObjectId, ref: "Warehouse" },
      shippingSac: { type: String, default: "996812" },
      trackInventory: { type: Boolean, default: true }, // new items track stock
    },
    // Shipping
    pkg: {
      weight: { type: Number, default: 0.5 }, // kg
      length: { type: Number, default: 20 }, // cm
      breadth: { type: Number, default: 15 },
      height: { type: Number, default: 10 },
    },
    fulfillInShopify: { type: Boolean, default: false },
    // Inventory sync (MGI → Shopify)
    inventorySync: { type: Boolean, default: false },
    locationId: { type: String, default: "" },
    locationName: { type: String, default: "" },
    stockFrom: { type: Date }, // Shopify orders from this date reserve stock until invoiced
    pushStatus: { at: Date, pushed: Number, errors: [String] },
    webhooks: { type: [String], default: [] },
    // Returns
    returnCreditNote: { type: Boolean, default: true }, // closing a return on an invoiced order makes a credit note // mark fulfilled with tracking when booked
    notifyCustomer: { type: Boolean, default: true },
    // GST rules
    rules: { type: [ruleSchema], default: undefined },
    fallbackTaxRate: { type: Number, default: 18 },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (doc, ret) => {
        ret.hasSecret = Boolean(ret.clientSecret);
        ret.hasToken = Boolean(ret.accessToken) && ret.authType === "token";
        delete ret.clientSecret;
        delete ret.accessToken;
        delete ret.tokenExpires;
        return ret;
      },
    },
  }
);

module.exports = mongoose.model("ShopifyStore", shopifyStoreSchema);
