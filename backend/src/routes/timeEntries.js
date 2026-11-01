const router = require("express").Router();
const Joi = require("joi");
const Project = require("../models/Project");
const TimeEntry = require("../models/TimeEntry");
const User = require("../models/User");
const { ah, validate, HttpError, round2 } = require("../utils/http");
const { istToday } = require("../utils/time");
const { rateOf, billedState } = require("./projects");

// "1.5", "1:30", "90m", "2h" → minutes
function parseDuration(v) {
  if (typeof v === "number") return Math.round(v * 60);
  const s = String(v || "").trim().toLowerCase();
  let m;
  if ((m = s.match(/^(\d+):(\d{1,2})$/))) return Number(m[1]) * 60 + Number(m[2]);
  if ((m = s.match(/^(\d+(?:\.\d+)?)\s*m(in)?s?$/))) return Math.round(Number(m[1]));
  if ((m = s.match(/^(\d+(?:\.\d+)?)\s*h(ou)?r?s?$/))) return Math.round(Number(m[1]) * 60);
  if ((m = s.match(/^(\d+(?:\.\d+)?)$/))) return Math.round(Number(m[1]) * 60);
  return NaN;
}

const schema = Joi.object({
  project: Joi.string().required().label("Project"),
  task: Joi.string().required().label("Task"),
  user: Joi.string().allow(""),
  date: Joi.date().required().label("Date"),
  duration: Joi.alternatives(Joi.number().min(0), Joi.string()).required().label("Time spent"),
  notes: Joi.string().allow(""),
  billable: Joi.boolean(),
});

const isManager = (req) => ["admin", "accountant"].includes(req.user.role);

async function prepare(req, data) {
  const p = await Project.findOne({ _id: data.project, organization: req.org });
  if (!p) throw new HttpError(400, "Choose a valid project");
  const task = p.tasks.id(data.task);
  if (!task) throw new HttpError(400, "Choose a task of this project");
  const minutes = parseDuration(data.duration);
  if (!(minutes > 0) || minutes > 24 * 60) throw new HttpError(400, "Enter the time spent, e.g. 1:30 or 1.5 (up to 24 hours)");
  let user = req.user;
  if (data.user && data.user !== String(req.user._id)) {
    if (!isManager(req)) throw new HttpError(403, "You can only log your own time");
    user = await User.findOne({ _id: data.user, organization: req.org });
    if (!user) throw new HttpError(400, "Choose a valid user");
  }
  return { project: p._id, task: task._id, user: user._id, userName: user.name, date: data.date, minutes, notes: data.notes || "", billable: data.billable ?? task.billable };
}

async function decorate(org, entries) {
  const projects = await Project.find({ organization: org, _id: { $in: [...new Set(entries.map((e) => String(e.project)))] } }).lean();
  const isBilled = await billedState(org, entries);
  return entries.map((e) => {
    const p = projects.find((x) => String(x._id) === String(e.project));
    const rate = p && p.billingMethod !== "fixed" && e.billable ? rateOf(p, e) : 0;
    return {
      ...e,
      projectName: p?.name || "",
      customerName: p?.customerName || "",
      taskName: p?.tasks.find((t) => String(t._id) === String(e.task))?.name || "",
      hours: round2(e.minutes / 60),
      rate,
      amount: round2((e.minutes / 60) * rate),
      billed: isBilled(e),
      running: Boolean(e.timerStartedAt),
    };
  });
}

router.get(
  "/",
  ah(async (req, res) => {
    const q = { organization: req.org, timerStartedAt: null };
    if (req.query.project) q.project = req.query.project;
    if (req.query.user) q.user = req.query.user;
    if (req.query.from || req.query.to) {
      q.date = {};
      if (req.query.from) q.date.$gte = new Date(`${req.query.from}T00:00:00.000Z`);
      if (req.query.to) q.date.$lte = new Date(`${req.query.to}T23:59:59.999Z`);
    }
    let rows = await decorate(req.org, await TimeEntry.find(q).sort({ date: -1, createdAt: -1 }).limit(2000).lean());
    if (req.query.status === "unbilled") rows = rows.filter((r) => r.billable && !r.billed);
    if (req.query.status === "billed") rows = rows.filter((r) => r.billed);
    if (req.query.status === "nonbillable") rows = rows.filter((r) => !r.billable);
    res.send(rows);
  })
);

// The current user's running timer, if any.
router.get(
  "/timer",
  ah(async (req, res) => {
    const t = await TimeEntry.findOne({ organization: req.org, user: req.user._id, timerStartedAt: { $ne: null } }).lean();
    res.send(t ? (await decorate(req.org, [t]))[0] : null);
  })
);

router.post(
  "/timer/start",
  ah(async (req, res) => {
    const data = validate(Joi.object({ project: Joi.string().required().label("Project"), task: Joi.string().required().label("Task"), notes: Joi.string().allow(""), billable: Joi.boolean() }), req.body);
    if (await TimeEntry.exists({ organization: req.org, user: req.user._id, timerStartedAt: { $ne: null } })) throw new HttpError(400, "A timer is already running. Stop it first.");
    const f = await prepare(req, { ...data, date: istToday(), duration: "1m" });
    const t = await TimeEntry.create({ ...f, minutes: 0, organization: req.org, timerStartedAt: new Date() });
    res.status(201).send((await decorate(req.org, [t.toObject()]))[0]);
  })
);

router.post(
  "/timer/stop",
  ah(async (req, res) => {
    const t = await TimeEntry.findOne({ organization: req.org, user: req.user._id, timerStartedAt: { $ne: null } });
    if (!t) throw new HttpError(400, "No timer is running");
    const mins = Math.max(1, Math.round((Date.now() - t.timerStartedAt.getTime()) / 60000));
    t.minutes = Math.min(mins, 24 * 60);
    t.timerStartedAt = null;
    if (req.body?.notes !== undefined) t.notes = req.body.notes;
    await t.save();
    res.send((await decorate(req.org, [t.toObject()]))[0]);
  })
);

router.delete(
  "/timer",
  ah(async (req, res) => {
    await TimeEntry.deleteOne({ organization: req.org, user: req.user._id, timerStartedAt: { $ne: null } });
    res.send({ message: "Timer discarded" });
  })
);

router.post(
  "/",
  ah(async (req, res) => {
    const f = await prepare(req, validate(schema, req.body));
    const t = await TimeEntry.create({ ...f, organization: req.org });
    res.status(201).send((await decorate(req.org, [t.toObject()]))[0]);
  })
);

async function editable(req) {
  const t = await TimeEntry.findOne({ _id: req.params.id, organization: req.org });
  if (!t) throw new HttpError(404, "Time entry not found");
  if (String(t.user) !== String(req.user._id) && !isManager(req)) throw new HttpError(403, "You can only change your own time");
  const [d] = await decorate(req.org, [t.toObject()]);
  if (d.billed) throw new HttpError(400, "This time is already invoiced. Delete or void the invoice first.");
  return t;
}

router.put(
  "/:id",
  ah(async (req, res) => {
    const t = await editable(req);
    t.set(await prepare(req, validate(schema, req.body)));
    t.invoice = undefined;
    await t.save();
    res.send((await decorate(req.org, [t.toObject()]))[0]);
  })
);

router.delete(
  "/:id",
  ah(async (req, res) => {
    const t = await editable(req);
    await t.deleteOne();
    res.send({ message: "Time entry deleted" });
  })
);

module.exports = router;
module.exports.parseDuration = parseDuration;
