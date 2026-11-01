const mongoose = require("mongoose");

// A custom role: access level per module ("none" | "view" | "full").
const roleSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    name: { type: String, required: true, trim: true },
    desc: { type: String, default: "" },
    perms: { type: mongoose.Schema.Types.Mixed, default: {} },
    home: { type: String, default: "" }, // page this role lands on, e.g. /returns-scan
  },
  { timestamps: true }
);
module.exports = mongoose.model("Role", roleSchema);
