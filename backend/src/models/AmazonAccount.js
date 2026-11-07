const mongoose = require("mongoose");

// A company's Amazon seller account, connected through Amazon's Selling Partner API (a private app the seller
// registers in Seller Central). Self-ship (MFN) and Easy Ship orders come into Store → Orders. One per company.
const amazonAccountSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, unique: true },
    name: { type: String, default: "Amazon.in" },
    sellerId: { type: String, default: "" }, // Merchant Token (Seller Central → Settings → Account Info)
    marketplaceId: { type: String, default: "A21TJRUUN4KGTV" }, // Amazon.in
    clientId: { type: String, default: "" }, // LWA client ID (amzn1.application-oa2-client…)
    clientSecret: { type: String, default: "" },
    refreshToken: { type: String, default: "" }, // Atzr|… from self-authorising the app
    accessToken: { type: String, default: "" },
    tokenExpires: { type: Date },
    connected: { type: Boolean, default: false },
    // Buyer name, phone and address need Amazon's restricted "Direct-to-Consumer Shipping" role.
    pii: { ok: { type: Boolean, default: false }, note: { type: String, default: "" }, checkedAt: Date },
    // Sync
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
      invoiced: { type: Number, default: 0 },
      error: { type: String, default: "" },
    },
    // Invoices: "ordexago" — OrdexaGo invoices each order when it's shipped (the monthly MTR import then skips
    // those orders); "amazon" — Amazon issues the invoices (Amazon tax invoicing) and the MTR import brings them in.
    invoiceBy: { type: String, enum: ["ordexago", "amazon"], default: "ordexago" },
    invoiceFrom: { type: Date }, // orders placed from this date are invoiced by OrdexaGo (set when connected)
    invoiceStatus: { type: String, enum: ["draft", "sent"], default: "sent" },
    ledger: { type: String, default: "" }, // sales ledger id; blank = "Amazon Sales"
    shippingSac: { type: String, default: "996812" },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (doc, ret) => {
        ret.hasSecret = Boolean(ret.clientSecret);
        ret.hasRefreshToken = Boolean(ret.refreshToken);
        delete ret.clientSecret;
        delete ret.refreshToken;
        delete ret.accessToken;
        delete ret.tokenExpires;
        return ret;
      },
    },
  }
);

// Secrets are stored encrypted (AES-256-GCM) and read back as plain text.
const { encryptFields, FIELDS } = require("../utils/secrets");
encryptFields(amazonAccountSchema, FIELDS.AmazonAccount);

module.exports = mongoose.model("AmazonAccount", amazonAccountSchema);
