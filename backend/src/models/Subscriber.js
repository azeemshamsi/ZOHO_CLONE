const mongoose = require("mongoose");

// A business that subscribes to OrdexaGo: its companies (Organization.subscriber) and users share one plan
// and one validity. The superadmin's own account is `owner` (never expires, no limits).
const subscriberSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true }, // business name
    contactName: { type: String, default: "" },
    email: { type: String, default: "", lowercase: true, trim: true },
    phone: { type: String, default: "" },
    plan: { type: mongoose.Schema.Types.ObjectId, ref: "Plan" },
    validTill: { type: Date }, // last day of access (end of that day, IST)
    graceDays: { type: Number, default: 7 }, // full access with a warning for this many days after validTill
    status: { type: String, enum: ["active", "suspended"], default: "active" },
    owner: { type: Boolean, default: false },
    notes: { type: String, default: "" },
    payments: [
      {
        date: Date,
        amount: Number,
        reference: { type: String, default: "" },
        note: { type: String, default: "" },
        validFrom: Date,
        validTill: Date,
        recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      },
    ],
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);
module.exports = mongoose.model("Subscriber", subscriberSchema);
