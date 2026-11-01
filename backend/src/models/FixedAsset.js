const mongoose = require("mongoose");

const fixedAssetSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    number: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    assetType: { type: String, default: "" }, // Furniture, Computers, Vehicles…
    account: { type: String, default: "fixed_assets" }, // Fixed Asset account it sits in
    serialNumber: { type: String, default: "" },
    location: { type: String, default: "" },
    description: { type: String, default: "" },
    acquisitionDate: { type: Date, required: true },
    cost: { type: Number, required: true },
    paidFrom: { type: String, default: "" }, // cash/bank account, "opening_equity" for assets already owned, "" = recorded elsewhere
    vendor: { type: String, default: "" },
    salvageValue: { type: Number, default: 0 },
    method: { type: String, enum: ["slm", "wdv", "none"], default: "slm" },
    usefulLifeYears: { type: Number, default: 5 }, // straight line
    rate: { type: Number, default: 0 }, // written down value, % per year
    depreciationStart: { type: Date }, // default: acquisition date
    status: { type: String, enum: ["active", "disposed"], default: "active" },
    disposal: {
      date: Date,
      kind: { type: String, enum: ["sold", "written_off"] },
      amount: { type: Number, default: 0 },
      account: { type: String, default: "" }, // where the sale money went
      notes: { type: String, default: "" },
    },
  },
  { timestamps: true }
);

fixedAssetSchema.index({ organization: 1, number: 1 }, { unique: true });
module.exports = mongoose.model("FixedAsset", fixedAssetSchema);
module.exports.ASSET_TYPES = ["Furniture & Fixtures", "Computers & IT Equipment", "Office Equipment", "Plant & Machinery", "Vehicles", "Buildings", "Land", "Electrical Installations", "Intangible Assets", "Other"];
