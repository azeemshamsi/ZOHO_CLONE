const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const env = require("../config/env");

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, default: "" }, // empty until an invited user accepts
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true },
    role: { type: String, default: "admin" }, // role in the first company (each company's role is on its Membership)
    status: { type: String, enum: ["active", "invited", "inactive"], default: "active" },
    invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    lastLogin: { type: Date },
    inviteToken: { type: String, default: "" },
    inviteExpires: { type: Date },
    verified: { type: Boolean, default: false },
  },
  { timestamps: true }
);

userSchema.methods.generateAuthToken = function () {
  return jwt.sign({ _id: this._id }, env.JWT_SECRET, { expiresIn: "7d" });
};

// r: the resolved role in the current company ({ label, perms, home }).
userSchema.methods.toPublic = function (r) {
  return {
    _id: this._id,
    name: this.name,
    email: this.email,
    role: this.role,
    roleLabel: r?.label || "",
    home: r?.home || "",
    status: this.status,
    organization: this.organization,
    permissions: r?.perms || require("../utils/roles").permsOf(this.role),
  };
};

module.exports = mongoose.model("User", userSchema);
