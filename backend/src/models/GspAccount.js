const mongoose = require("mongoose");

// A company's GST Suvidha Provider (GSP) connection: Clear. The token never goes to the browser.
const gspAccountSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, unique: true },
    provider: { type: String, enum: ["clear"], default: "clear" },
    env: { type: String, enum: ["sandbox", "production"], default: "sandbox" },
    host: { type: String, default: "" }, // blank = Clear's default for the environment
    token: { type: String, default: "" },
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
        ret.tokenEnd = ret.token ? ret.token.slice(-4) : "";
        delete ret.token;
        return ret;
      },
    },
  }
);

module.exports = mongoose.model("GspAccount", gspAccountSchema);
