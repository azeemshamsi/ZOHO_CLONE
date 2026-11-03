const mongoose = require("mongoose");

// A courier's pincode lists: zone per pincode, out-of-delivery-area (EDL) and ECC pincodes.
const courierPincodeSchema = new mongoose.Schema({
  organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true },
  account: { type: mongoose.Schema.Types.ObjectId, ref: "CourierAccount", required: true },
  kind: { type: String, enum: ["zone", "edl", "ecc"], required: true },
  pincode: { type: String, required: true },
  zone: { type: String, default: "" },
});
courierPincodeSchema.index({ account: 1, kind: 1, pincode: 1 });

module.exports = mongoose.model("CourierPincode", courierPincodeSchema);
