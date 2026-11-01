const mongoose = require("mongoose");

// A foreign currency the organization deals in. The base currency (INR) isn't stored.
const currencySchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    code: { type: String, required: true, uppercase: true, trim: true },
    symbol: { type: String, default: "" },
    name: { type: String, default: "" },
    rate: { type: Number, required: true }, // ₹ per 1 unit, used as the default on new documents
    rates: [{ _id: false, date: Date, rate: Number }], // history
    rateSource: { type: String, default: "manual" },
    rateUpdatedAt: { type: Date },
  },
  { timestamps: true }
);
currencySchema.index({ organization: 1, code: 1 }, { unique: true });
module.exports = mongoose.model("Currency", currencySchema);
module.exports.COMMON = [
  ["USD", "$", "US Dollar"], ["EUR", "€", "Euro"], ["GBP", "£", "British Pound"], ["AED", "AED", "UAE Dirham"], ["SAR", "SAR", "Saudi Riyal"],
  ["SGD", "S$", "Singapore Dollar"], ["AUD", "A$", "Australian Dollar"], ["CAD", "C$", "Canadian Dollar"], ["JPY", "¥", "Japanese Yen"], ["CNY", "¥", "Chinese Yuan"],
  ["CHF", "CHF", "Swiss Franc"], ["NPR", "Rs", "Nepalese Rupee"], ["BDT", "৳", "Bangladeshi Taka"], ["LKR", "Rs", "Sri Lankan Rupee"], ["MYR", "RM", "Malaysian Ringgit"],
  ["QAR", "QAR", "Qatari Riyal"], ["KWD", "KD", "Kuwaiti Dinar"], ["OMR", "OMR", "Omani Rial"], ["NZD", "NZ$", "New Zealand Dollar"], ["HKD", "HK$", "Hong Kong Dollar"],
];
