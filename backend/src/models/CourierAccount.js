const mongoose = require("mongoose");

// A courier account used to book shipments (Shiprocket, Delhivery, Blue Dart, DTDC, Shadowfax, or a custom courier).
const courierAccountSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    carrier: { type: String, enum: ["shiprocket", "delhivery", "bluedart", "dtdc", "shadowfax", "custom"], required: true },
    name: { type: String, required: true, trim: true },
    active: { type: Boolean, default: true },
    isDefault: { type: Boolean, default: false },
    test: { type: Boolean, default: false }, // carrier's staging/sandbox where it has one
    baseUrl: { type: String, default: "" }, // override the API address
    // Secrets and ids, by carrier (see utils/couriers). Never sent to the browser.
    credentials: { type: mongoose.Schema.Types.Mixed, default: {} },
    // Non-secret options: pickup location name, client code, service type…
    options: { type: mongoose.Schema.Types.Mixed, default: {} },
    pickup: {
      name: { type: String, default: "" },
      phone: { type: String, default: "" },
      address: { type: String, default: "" },
      city: { type: String, default: "" },
      state: { type: String, default: "" },
      pincode: { type: String, default: "" },
    },
    trackingUrl: { type: String, default: "" }, // template with {awb}
    token: { type: String, default: "" }, // cached session token
    tokenExpires: { type: Date },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (doc, ret) => {
        ret.credentialKeys = Object.keys(ret.credentials || {}).filter((k) => ret.credentials[k]);
        delete ret.credentials;
        delete ret.token;
        delete ret.tokenExpires;
        return ret;
      },
    },
  }
);

module.exports = mongoose.model("CourierAccount", courierAccountSchema);
