const mongoose = require("mongoose");

// Pincode → state and district (from api.postalpincode.in), cached. Misses are cached too.
const pincodeLookupSchema = new mongoose.Schema({
  pincode: { type: String, required: true, unique: true },
  state: { type: String, default: null },
  district: { type: String, default: null },
  at: { type: Date, default: Date.now },
});

module.exports = mongoose.model("PincodeLookup", pincodeLookupSchema);
