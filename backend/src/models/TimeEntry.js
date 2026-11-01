const mongoose = require("mongoose");

// Time logged against a project task. A running timer has `timerStartedAt` set.
const timeEntrySchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    project: { type: mongoose.Schema.Types.ObjectId, ref: "Project", required: true, index: true },
    task: { type: mongoose.Schema.Types.ObjectId, required: true }, // a project.tasks[] _id
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    userName: { type: String, default: "" },
    date: { type: Date, required: true },
    minutes: { type: Number, default: 0 },
    notes: { type: String, default: "" },
    billable: { type: Boolean, default: true },
    invoice: { type: mongoose.Schema.Types.ObjectId, ref: "Invoice" }, // set once billed
    timerStartedAt: { type: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.model("TimeEntry", timeEntrySchema);
