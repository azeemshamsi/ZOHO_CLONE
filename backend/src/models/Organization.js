const mongoose = require("mongoose");

const addressSchema = new mongoose.Schema(
  {
    street: { type: String, default: "" },
    city: { type: String, default: "" },
    state: { type: String, default: "" }, // GST state code, e.g. "27"
    pincode: { type: String, default: "" },
    country: { type: String, default: "India" },
  },
  { _id: false }
);

const organizationSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    gstin: { type: String, default: "", uppercase: true, trim: true },
    state: { type: String, required: true }, // GST state code of the business
    address: { type: addressSchema, default: () => ({}) },
    email: { type: String, default: "" },
    phone: { type: String, default: "" },
    website: { type: String, default: "" },
    currency: { type: String, default: "INR" },
    invoicePrefix: { type: String, default: "INV-" },
    paymentPrefix: { type: String, default: "PAY-" },
    quotePrefix: { type: String, default: "QT-" },
    salesOrderPrefix: { type: String, default: "SO-" },
    creditNotePrefix: { type: String, default: "CN-" },
    vendorPaymentPrefix: { type: String, default: "PM-" },
    journalPrefix: { type: String, default: "MJ-" },
    purchaseOrderPrefix: { type: String, default: "PO-" },
    vendorCreditPrefix: { type: String, default: "DN-" },
    defaultPaymentTerms: { type: Number, default: 15 },
    defaultNotes: { type: String, default: "Thanks for your business." },
    defaultTerms: { type: String, default: "" },
    // Outgoing email (e.g. Gmail with an app password). Falls back to the server's SMTP settings.
    smtp: {
      provider: { type: String, enum: ["smtp", "brevo", "resend"], default: "smtp" },
      apiKey: { type: String, default: "" },
      host: { type: String, default: "" },
      port: { type: Number, default: 587 },
      secure: { type: Boolean, default: false },
      user: { type: String, default: "" },
      pass: { type: String, default: "" },
      fromName: { type: String, default: "" },
    },
    // Automatic payment reminders: days after the due date to remind (e.g. [1, 7, 15]).
    fxAutoUpdate: { type: Boolean, default: false }, // fetch exchange rates daily
    einvoicing: { enabled: { type: Boolean, default: false }, fromDate: { type: Date } },
    ewayBills: { enabled: { type: Boolean, default: false }, threshold: { type: Number, default: 50000 } },
    // Google Gemini API key, used to read scanned bills and photos.
    ai: { geminiKey: { type: String, default: "" }, model: { type: String, default: "" } },
    gstFiling: { frequency: { type: String, enum: ["monthly", "quarterly"], default: "monthly" } },
    fxUpdatedAt: { type: Date },
    reminders: {
      enabled: { type: Boolean, default: false },
      days: { type: [Number], default: [3, 10] },
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (doc, ret) => {
        // Never send the SMTP password to the browser.
        if (ret.smtp) {
          ret.smtp.hasPassword = Boolean(ret.smtp.pass);
          ret.smtp.hasApiKey = Boolean(ret.smtp.apiKey);
          delete ret.smtp.pass;
          delete ret.smtp.apiKey;
        }
        if (ret.ai) {
          ret.ai = { hasGeminiKey: Boolean(ret.ai.geminiKey), model: ret.ai.model || "" };
        }
        return ret;
      },
    },
  }
);

module.exports = mongoose.model("Organization", organizationSchema);
module.exports.addressSchema = addressSchema;
