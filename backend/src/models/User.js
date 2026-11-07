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
    superadmin: { type: Boolean, default: false }, // OrdexaGo's own operator: manages subscribers and plans
    // Lockout after repeated wrong passwords (utils/lockout.js)
    loginFailures: { count: { type: Number, default: 0 }, since: { type: Date } },
    lockedUntil: { type: Date },
    // Password policy (utils/password.js): expiry after 365 days, last 5 can't be reused
    passwordChangedAt: { type: Date },
    passwordHistory: { type: [String], default: [] },
    tokenVersion: { type: Number, default: 0 }, // raised on password change / 2FA reset: signs out every session
    // Two-step login (TOTP). Secrets are stored encrypted.
    totp: {
      enabled: { type: Boolean, default: false },
      secret: { type: String, default: "" },
      pendingSecret: { type: String, default: "" }, // during setup, until the first code is confirmed
      recoveryCodes: { type: [String], default: [] }, // SHA-256 hashes of unused one-time codes
      enabledAt: { type: Date },
      lastStep: { type: Number, default: -1 }, // last used time step (a code can't be used twice)
    },
  },
  { timestamps: true }
);

// Session token: 12 hours, renewed while the user is active (middleware/auth.js). `mfa`: passed two-step login.
// tv = token version: changing the password signs out every other session.
const SESSION_HOURS = 12;
userSchema.methods.generateAuthToken = function (mfa = false) {
  return jwt.sign({ _id: this._id, tv: this.tokenVersion || 0, typ: "s", mfa: !!mfa }, env.JWT_SECRET, { expiresIn: `${SESSION_HOURS}h` });
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
    superadmin: !!this.superadmin,
    twoFactor: !!this.totp?.enabled,
  };
};

const { encryptFields, FIELDS } = require("../utils/secrets");
encryptFields(userSchema, FIELDS.User);

module.exports = mongoose.model("User", userSchema);
