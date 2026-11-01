const router = require("express").Router();
const Joi = require("joi");
const Project = require("../models/Project");
const TimeEntry = require("../models/TimeEntry");
const Customer = require("../models/Customer");
const Invoice = require("../models/Invoice");
const User = require("../models/User");
const { ah, validate, HttpError, round2 } = require("../utils/http");
const { istToday } = require("../utils/time");

const schema = Joi.object({
  name: Joi.string().trim().required().label("Project name"),
  code: Joi.string().allow(""),
  customer: Joi.string().required().label("Customer"),
  description: Joi.string().allow(""),
  billingMethod: Joi.string().valid("fixed", "project_hours", "task_hours", "staff_hours").required(),
  fixedAmount: Joi.number().min(0).default(0),
  rate: Joi.number().min(0).default(0),
  budgetHours: Joi.number().min(0).default(0),
  budgetAmount: Joi.number().min(0).default(0),
  taxRate: Joi.number().min(0).max(28).default(18),
  sac: Joi.string().allow(""),
  status: Joi.string().valid("active", "inactive"),
  tasks: Joi.array()
    .items(Joi.object({ _id: Joi.string().allow(""), name: Joi.string().trim().required().label("Task name"), description: Joi.string().allow(""), rate: Joi.number().min(0).default(0), billable: Joi.boolean().default(true) }))
    .min(1)
    .required()
    .label("Tasks"),
  users: Joi.array().items(Joi.object({ user: Joi.string().required(), rate: Joi.number().min(0).default(0) }).unknown(true)).default([]),
});

async function prepare(req, data) {
  const c = await Customer.findOne({ _id: data.customer, organization: req.org });
  if (!c) throw new HttpError(400, "Choose a valid customer");
  const users = await User.find({ organization: req.org, _id: { $in: data.users.map((u) => u.user) } }).lean();
  data.users = data.users.filter((u) => users.some((x) => String(x._id) === u.user)).map((u) => ({ user: u.user, rate: u.rate, name: users.find((x) => String(x._id) === u.user).name }));
  data.tasks = data.tasks.map((t) => {
    const out = { ...t };
    if (!out._id) delete out._id;
    return out;
  });
  return { ...data, customerName: c.displayName };
}

// Hourly rate for an entry under the project's billing method.
function rateOf(p, e) {
  if (p.billingMethod === "project_hours") return p.rate;
  if (p.billingMethod === "task_hours") return p.tasks.find((t) => String(t._id) === String(e.task))?.rate || 0;
  if (p.billingMethod === "staff_hours") return p.users.find((u) => String(u.user) === String(e.user))?.rate || 0;
  return 0;
}

// Entries whose invoice was deleted or voided count as unbilled again.
async function billedState(org, entries) {
  const ids = [...new Set(entries.filter((e) => e.invoice).map((e) => String(e.invoice)))];
  const live = new Set((await Invoice.find({ organization: org, _id: { $in: ids }, status: { $ne: "void" } }, { _id: 1 }).lean()).map((i) => String(i._id)));
  return (e) => Boolean(e.invoice && live.has(String(e.invoice)));
}

async function summary(org, p) {
  const entries = await TimeEntry.find({ organization: org, project: p._id, timerStartedAt: null }).lean();
  const isBilled = await billedState(org, entries);
  const invoices = await Invoice.find({ organization: org, project: p._id }, { lineItems: 0 }).sort({ date: -1 }).lean();
  const live = invoices.filter((i) => i.status !== "void");
  const hrs = (xs) => round2(xs.reduce((s, e) => s + e.minutes, 0) / 60);
  const billable = entries.filter((e) => e.billable);
  const unbilled = billable.filter((e) => !isBilled(e));
  return {
    loggedHours: hrs(entries),
    billableHours: hrs(billable),
    billedHours: hrs(billable.filter(isBilled)),
    unbilledHours: hrs(unbilled),
    unbilledAmount: p.billingMethod === "fixed" ? 0 : round2(unbilled.reduce((s, e) => s + (e.minutes / 60) * rateOf(p, e), 0)),
    invoicedAmount: round2(live.reduce((s, i) => s + i.subTotal, 0)),
    fixedRemaining: p.billingMethod === "fixed" ? round2(Math.max(0, p.fixedAmount - live.reduce((s, i) => s + i.subTotal, 0))) : 0,
    invoices: invoices.map((i) => ({ _id: i._id, invoiceNumber: i.invoiceNumber, date: i.date, total: i.total, status: i.status, balance: i.balance })),
  };
}

router.get(
  "/",
  ah(async (req, res) => {
    const q = { organization: req.org };
    if (req.query.status) q.status = req.query.status;
    if (req.query.customer) q.customer = req.query.customer;
    const projects = await Project.find(q).sort({ status: 1, name: 1 }).lean();
    if (req.query.summary === "0") return res.send(projects);
    const out = [];
    for (const p of projects) out.push({ ...p, summary: await summary(req.org, p) });
    res.send(out);
  })
);

router.get(
  "/:id",
  ah(async (req, res) => {
    const p = await Project.findOne({ _id: req.params.id, organization: req.org }).lean();
    if (!p) throw new HttpError(404, "Project not found");
    res.send({ ...p, summary: await summary(req.org, p) });
  })
);

router.post(
  "/",
  ah(async (req, res) => {
    const data = await prepare(req, validate(schema, req.body));
    res.status(201).send(await Project.create({ ...data, organization: req.org }));
  })
);

router.put(
  "/:id",
  ah(async (req, res) => {
    const data = await prepare(req, validate(schema, req.body));
    const p = await Project.findOne({ _id: req.params.id, organization: req.org });
    if (!p) throw new HttpError(404, "Project not found");
    // A task with logged time can't be removed.
    const keep = new Set(data.tasks.filter((t) => t._id).map((t) => String(t._id)));
    for (const t of p.tasks)
      if (!keep.has(String(t._id)) && (await TimeEntry.exists({ project: p._id, task: t._id }))) throw new HttpError(400, `Task "${t.name}" has time logged and can't be removed`);
    p.set(data);
    await p.save();
    res.send(p);
  })
);

router.delete(
  "/:id",
  ah(async (req, res) => {
    const p = await Project.findOne({ _id: req.params.id, organization: req.org });
    if (!p) throw new HttpError(404, "Project not found");
    if (await TimeEntry.exists({ project: p._id })) throw new HttpError(400, "This project has time logged. Mark it inactive instead.");
    if (await Invoice.exists({ project: p._id })) throw new HttpError(400, "This project has invoices. Mark it inactive instead.");
    await p.deleteOne();
    res.send({ message: "Project deleted" });
  })
);

// Unbilled billable time, ready to invoice.
router.get(
  "/:id/unbilled",
  ah(async (req, res) => {
    const p = await Project.findOne({ _id: req.params.id, organization: req.org }).lean();
    if (!p) throw new HttpError(404, "Project not found");
    const q = { organization: req.org, project: p._id, billable: true, timerStartedAt: null };
    if (req.query.to) q.date = { $lte: new Date(`${req.query.to}T23:59:59.999Z`) };
    if (req.query.from) q.date = { ...(q.date || {}), $gte: new Date(`${req.query.from}T00:00:00.000Z`) };
    const entries = await TimeEntry.find(q).sort({ date: 1 }).lean();
    const isBilled = await billedState(req.org, entries);
    const taskName = (id) => p.tasks.find((t) => String(t._id) === String(id))?.name || "Task";
    res.send(
      entries
        .filter((e) => !isBilled(e))
        .map((e) => ({ ...e, taskName: taskName(e.task), hours: round2(e.minutes / 60), rate: rateOf(p, e), amount: round2((e.minutes / 60) * rateOf(p, e)) }))
    );
  })
);

// Create a draft invoice from the project: chosen time entries, or the fixed fee.
router.post(
  "/:id/invoice",
  ah(async (req, res) => {
    const data = validate(
      Joi.object({
        entries: Joi.array().items(Joi.string()).default([]),
        groupBy: Joi.string().valid("task", "user", "project", "entry").default("task"),
        amount: Joi.number().min(0), // fixed-fee projects: how much to bill now (default: what's left)
        date: Joi.date(),
      }),
      req.body
    );
    const p = await Project.findOne({ _id: req.params.id, organization: req.org }).lean();
    if (!p) throw new HttpError(404, "Project not found");
    const hsn = p.sac || "";
    let lines = [];
    let entries = [];
    if (p.billingMethod === "fixed") {
      const left = (await summary(req.org, p)).fixedRemaining;
      const amount = round2(data.amount ?? left);
      if (!(amount > 0)) throw new HttpError(400, "Nothing left to bill on this project");
      lines = [{ name: p.name, description: p.description || "Project fee", hsnSac: hsn, quantity: 1, rate: amount, taxRate: p.taxRate, unit: "" }];
    } else {
      if (!data.entries.length) throw new HttpError(400, "Pick the time entries to bill");
      entries = await TimeEntry.find({ organization: req.org, project: p._id, _id: { $in: data.entries }, billable: true, timerStartedAt: null }).sort({ date: 1 }).lean();
      const isBilled = await billedState(req.org, entries);
      entries = entries.filter((e) => !isBilled(e));
      if (!entries.length) throw new HttpError(400, "Those entries are already billed");
      const taskName = (id) => p.tasks.find((t) => String(t._id) === String(id))?.name || "Task";
      const groups = new Map();
      for (const e of entries) {
        const rate = rateOf(p, e);
        const key =
          data.groupBy === "entry" ? String(e._id) : data.groupBy === "user" ? `${e.user}|${rate}` : data.groupBy === "project" ? `p|${rate}` : `${e.task}|${rate}`;
        const name =
          data.groupBy === "entry"
            ? `${taskName(e.task)} — ${new Date(e.date).toISOString().slice(0, 10)}`
            : data.groupBy === "user"
            ? `${p.name} — ${e.userName}`
            : data.groupBy === "project"
            ? p.name
            : `${p.name} — ${taskName(e.task)}`;
        const g = groups.get(key) || { name, description: data.groupBy === "entry" ? e.notes : "", minutes: 0, rate };
        g.minutes += e.minutes;
        groups.set(key, g);
      }
      lines = [...groups.values()].map((g) => ({ name: g.name, description: g.description, hsnSac: hsn, quantity: round2(g.minutes / 60), rate: g.rate, taxRate: p.taxRate, unit: "hrs" }));
    }
    const today = (data.date ? new Date(data.date) : istToday()).toISOString().slice(0, 10);
    const c = await Customer.findById(p.customer).lean();
    const due = new Date(new Date(today).getTime() + (c?.paymentTerms ?? 15) * 86400000).toISOString().slice(0, 10);
    const inv = await require("./invoices").createInvoice(req, { customer: String(p.customer), date: today, dueDate: due, status: "draft", lineItems: lines });
    inv.project = p._id;
    await inv.save();
    if (entries.length) await TimeEntry.updateMany({ _id: { $in: entries.map((e) => e._id) } }, { invoice: inv._id });
    res.status(201).send(inv);
  })
);

module.exports = router;
module.exports.rateOf = rateOf;
module.exports.billedState = billedState;
module.exports.summaryOf = summary;
