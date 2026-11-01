const router = require("express").Router();
const Joi = require("joi");
const RecurringProfile = require("../models/RecurringProfile");
const Customer = require("../models/Customer");
const Vendor = require("../models/Vendor");
const { ah, validate, HttpError, round2 } = require("../utils/http");
const { refreshNext, runProfile, runDue } = require("../utils/recurring");
const { istToday } = require("../utils/time");

const schema = Joi.object({
  kind: Joi.string().valid("invoice", "bill", "expense").required(),
  name: Joi.string().trim().required().label("Profile name"),
  every: Joi.number().integer().min(1).max(365).default(1),
  unit: Joi.string().valid("day", "week", "month", "year").default("month"),
  startDate: Joi.date().required().label("Start date"),
  endDate: Joi.date().allow(null, "").label("End date"),
  paymentTerms: Joi.number().integer().min(0).max(365).default(0),
  createAs: Joi.string().valid("draft", "final").default("final"),
  template: Joi.object().unknown(true).required(),
});

const MOD = { invoice: "../routes/invoices", bill: "../routes/bills", expense: "../routes/expenses" };

async function prepare(req, data) {
  if (data.endDate === "") data.endDate = null;
  if (data.endDate && new Date(data.endDate) < new Date(data.startDate)) throw new HttpError(400, "End date can't be before the start date");
  const t = { ...data.template };
  delete t.date;
  delete t.dueDate;
  delete t.status;
  delete t.invoiceNumber;
  // Check the template the same way a real document would be checked.
  const sample = { ...t, date: "2026-01-01", ...(data.kind !== "expense" ? { dueDate: "2026-12-31" } : {}), ...(data.kind === "bill" ? { billNumber: t.billNumber || "RB" } : {}) };
  validate(require(MOD[data.kind]).schema, sample);
  let partyName = "";
  if (data.kind === "invoice") partyName = (await Customer.findOne({ _id: t.customer, organization: req.org }))?.displayName;
  else if (data.kind === "bill") partyName = (await Vendor.findOne({ _id: t.vendor, organization: req.org }))?.displayName;
  else partyName = t.vendor ? (await Vendor.findOne({ _id: t.vendor, organization: req.org }))?.displayName || "" : t.category;
  if (partyName === undefined || partyName === null) throw new HttpError(400, data.kind === "invoice" ? "Choose a valid customer" : "Choose a valid vendor");
  let amount;
  if (data.kind === "expense") amount = t.taxInclusive ? Number(t.amount) : Number(t.amount) * (1 + (Number(t.taxRate) || 0) / 100);
  else
    amount =
      (t.lineItems || []).reduce((s, l) => s + Number(l.quantity) * Number(l.rate) * (1 - (Number(l.discount) || 0) / 100) * (1 + (Number(l.taxRate) || 0) / 100), 0) +
      (Number(t.shippingCharge) || 0) +
      (Number(t.adjustment) || 0);
  return { ...data, template: t, partyName, amount: round2(amount) };
}

router.get(
  "/",
  ah(async (req, res) => {
    await runDue(req.org); // catch up anything due before showing the list
    const q = { organization: req.org };
    if (req.query.kind) q.kind = req.query.kind;
    res.send(await RecurringProfile.find(q, { history: 0 }).sort({ createdAt: -1 }));
  })
);

router.get(
  "/:id",
  ah(async (req, res) => {
    const p = await RecurringProfile.findOne({ _id: req.params.id, organization: req.org });
    if (!p) throw new HttpError(404, "Recurring profile not found");
    res.send(p);
  })
);

router.post(
  "/",
  ah(async (req, res) => {
    const data = await prepare(req, validate(schema, req.body));
    const p = new RecurringProfile({ ...data, organization: req.org, occurrences: 0 });
    refreshNext(p);
    await p.save();
    await runProfile(p); // create anything already due (e.g. a start date of today)
    res.status(201).send(p);
  })
);

router.put(
  "/:id",
  ah(async (req, res) => {
    const p = await RecurringProfile.findOne({ _id: req.params.id, organization: req.org });
    if (!p) throw new HttpError(404, "Recurring profile not found");
    const data = await prepare(req, validate(schema, { ...req.body, kind: p.kind }));
    // Changing the schedule restarts counting from the new start date (only future dates).
    const scheduleChanged = iso(data.startDate) !== iso(p.startDate) || data.every !== p.every || data.unit !== p.unit;
    p.set(data);
    if (scheduleChanged) {
      p.occurrences = 0;
      refreshNext(p);
      const today = istToday();
      while (p.nextDate < today && p.occurrences < 2000) {
        p.occurrences += 1;
        refreshNext(p);
      }
      if (p.history.length && p.nextDate <= new Date(p.history[p.history.length - 1].date)) {
        p.occurrences += 1;
        refreshNext(p);
      }
    } else refreshNext(p);
    await p.save();
    await runProfile(p);
    res.send(p);
  })
);
const iso = (d) => new Date(d).toISOString().slice(0, 10);

router.post(
  "/:id/status",
  ah(async (req, res) => {
    const { status } = validate(Joi.object({ status: Joi.string().valid("active", "stopped").required() }), req.body);
    const p = await RecurringProfile.findOne({ _id: req.params.id, organization: req.org });
    if (!p) throw new HttpError(404, "Recurring profile not found");
    p.status = status;
    if (status === "active") {
      // Resume from today: skip the dates missed while stopped.
      const today = istToday();
      refreshNext(p);
      while (p.nextDate < today && p.occurrences < 5000) {
        p.occurrences += 1;
        refreshNext(p);
      }
    }
    await p.save();
    await runProfile(p);
    res.send(p);
  })
);

router.delete(
  "/:id",
  ah(async (req, res) => {
    const r = await RecurringProfile.deleteOne({ _id: req.params.id, organization: req.org });
    if (!r.deletedCount) throw new HttpError(404, "Recurring profile not found");
    res.send({ message: "Recurring profile deleted. Documents it already created are kept." });
  })
);

module.exports = router;
