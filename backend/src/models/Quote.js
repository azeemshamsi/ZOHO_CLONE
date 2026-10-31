const mongoose = require("mongoose");
const { salesDocFields, startOfToday } = require("./shared");

const quoteSchema = new mongoose.Schema(
  {
    ...salesDocFields(),
    number: { type: String, required: true },
    reference: { type: String, default: "" },
    expiryDate: { type: Date },
    status: {
      type: String,
      enum: ["draft", "sent", "accepted", "declined", "invoiced"],
      default: "draft",
    },
    // What this quote was converted into (sales order or invoice).
    convertedTo: {
      kind: { type: String, enum: ["salesOrder", "invoice"] },
      id: { type: mongoose.Schema.Types.ObjectId },
      number: { type: String },
    },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

quoteSchema.index({ organization: 1, number: 1 }, { unique: true });

quoteSchema.virtual("displayStatus").get(function () {
  if (this.status === "sent" && this.expiryDate && this.expiryDate < startOfToday()) return "expired";
  return this.status;
});

module.exports = mongoose.model("Quote", quoteSchema);
