const mongoose = require("mongoose");

/**
 * Security audit log: who did what, from where. Append-only — there are no routes to change or delete entries,
 * and updates/deletes through the model are refused. Entries older than 400 days are purged daily straight
 * on the collection (utils/audit.js purgeOld). Never holds passwords, tokens or buyer names/addresses/phones.
 */
const auditLogSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    email: { type: String, default: "" }, // the account's login email (for failed logins with no user)
    action: { type: String, required: true },
    target: { type: String, default: "" },
    ip: { type: String, default: "" },
    deviceId: { type: String, default: "" },
    userAgent: { type: String, default: "" },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
    at: { type: Date, default: Date.now, index: true },
  },
  { versionKey: false }
);
auditLogSchema.index({ organization: 1, at: -1 });

const refuse = function () {
  throw new Error("The security log is append-only");
};
for (const op of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "deleteOne", "deleteMany", "findOneAndDelete", "findOneAndReplace"]) auditLogSchema.pre(op, refuse);
auditLogSchema.pre("save", function (next) {
  if (!this.isNew) return next(new Error("The security log is append-only"));
  next();
});

module.exports = mongoose.model("AuditLog", auditLogSchema);
