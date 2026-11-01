const mongoose = require("mongoose");

// Put-away and moves between racks. from = null: put away from unassigned stock; to = null: taken off a rack.
const rackMoveSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    item: { type: mongoose.Schema.Types.ObjectId, ref: "Item", required: true },
    warehouse: { type: mongoose.Schema.Types.ObjectId, ref: "Warehouse", default: null },
    from: { type: mongoose.Schema.Types.ObjectId, ref: "Rack", default: null },
    to: { type: mongoose.Schema.Types.ObjectId, ref: "Rack", default: null },
    qty: { type: Number, required: true },
    note: { type: String, default: "" },
    user: { type: String, default: "" },
  },
  { timestamps: true }
);
rackMoveSchema.index({ organization: 1, item: 1 });
module.exports = mongoose.model("RackMove", rackMoveSchema);
