const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const env = require("../config/env");

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true },
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true },
    role: { type: String, enum: ["admin", "staff"], default: "admin" },
    verified: { type: Boolean, default: false },
  },
  { timestamps: true }
);

userSchema.methods.generateAuthToken = function () {
  return jwt.sign({ _id: this._id }, env.JWT_SECRET, { expiresIn: "7d" });
};

userSchema.methods.toPublic = function () {
  return {
    _id: this._id,
    name: this.name,
    email: this.email,
    role: this.role,
    organization: this.organization,
  };
};

module.exports = mongoose.model("User", userSchema);
