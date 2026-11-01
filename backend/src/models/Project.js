const mongoose = require("mongoose");

// A customer project whose time (or a fixed fee) is billed through invoices.
const projectSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    name: { type: String, required: true, trim: true },
    code: { type: String, default: "" },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
    customerName: { type: String, default: "" },
    description: { type: String, default: "" },
    // fixed = one project fee; project_hours = one hourly rate; task_hours = rate per task; staff_hours = rate per person
    billingMethod: { type: String, enum: ["fixed", "project_hours", "task_hours", "staff_hours"], default: "project_hours" },
    fixedAmount: { type: Number, default: 0 },
    rate: { type: Number, default: 0 }, // project_hours
    budgetHours: { type: Number, default: 0 },
    budgetAmount: { type: Number, default: 0 },
    taxRate: { type: Number, default: 18 },
    sac: { type: String, default: "998311" }, // SAC for management consulting; change as needed
    tasks: [
      {
        name: { type: String, required: true },
        description: { type: String, default: "" },
        rate: { type: Number, default: 0 }, // task_hours
        billable: { type: Boolean, default: true },
      },
    ],
    users: [
      {
        _id: false,
        user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
        name: { type: String, default: "" },
        rate: { type: Number, default: 0 }, // staff_hours
      },
    ],
    status: { type: String, enum: ["active", "inactive"], default: "active" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Project", projectSchema);
