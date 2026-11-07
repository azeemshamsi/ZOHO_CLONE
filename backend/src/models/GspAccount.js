const mongoose = require("mongoose");

// A company's GST Suvidha Provider (GSP) connection: Clear. The token never goes to the browser.
const gspAccountSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, unique: true },
    provider: { type: String, enum: ["clear"], default: "clear" },
    env: { type: String, enum: ["sandbox", "production"], default: "sandbox" },
    host: { type: String, default: "" }, // blank = Clear's default for the environment
    // "token": Clear auth token (E-Invoicing API). "gsp": client ID/secret + API username/password (E-Invoicing GSP API).
    mode: { type: String, enum: ["token", "gsp"], default: "token" },
    token: { type: String, default: "" },
    clientId: { type: String, default: "" },
    clientSecret: { type: String, default: "" },
    username: { type: String, default: "" },
    password: { type: String, default: "" },
    publicKey: { type: String, default: "" },
    // GSP session (NIC): token + session key, renewed automatically
    authToken: { type: String, default: "" },
    sek: { type: String, default: "" },
    tokenExpiry: Date,
    tokenGstin: { type: String, default: "" },
    gstin: { type: String, default: "" }, // blank = the company's GSTIN
    active: { type: Boolean, default: false },
    lastCheckAt: Date,
    lastError: { type: String, default: "" },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (doc, ret) => {
        ret.tokenSaved = !!ret.token;
        ret.tokenEnd = ret.token ? String(require("../utils/secrets").decrypt(ret.token)).slice(-4) : "";
        ret.secretSaved = !!ret.clientSecret;
        ret.passwordSaved = !!ret.password;
        ret.publicKeySaved = !!ret.publicKey;
        for (const k of ["token", "clientSecret", "password", "authToken", "sek", "publicKey"]) delete ret[k];
        return ret;
      },
    },
  }
);

// Secrets are stored encrypted (AES-256-GCM) and read back as plain text.
const { encryptFields, FIELDS } = require("../utils/secrets");
encryptFields(gspAccountSchema, FIELDS.GspAccount);

module.exports = mongoose.model("GspAccount", gspAccountSchema);
