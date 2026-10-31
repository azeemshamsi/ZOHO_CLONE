const router = require("express").Router();
const Joi = require("joi");
const Expense = require("../models/Expense");
const { EXPENSE_CATEGORIES } = require("../models/Expense");
const Vendor = require("../models/Vendor");
const Organization = require("../models/Organization");
const { ah, validate, HttpError, round2 } = require("../utils/http");
const { escapeRx } = require("../utils/salesDoc");

const schema = Joi.object({
  date: Joi.date().required().label("Date"),
  category: Joi.string().required().label("Expense account"),
  amount: Joi.number().greater(0).required().label("Amount"),
  taxInclusive: Joi.boolean().default(false),
  taxRate: Joi.number().min(0).max(100).default(0),
  placeOfSupply: Joi.string().allow(""),
  vendor: Joi.string().allow(null, ""),
  paidThrough: Joi.string().valid("cash", "bank_transfer", "upi", "cheque", "card", "other"),
  reference: Joi.string().allow(""),
  notes: Joi.string().allow(""),
});

async function build(req, data) {
  const org = await Organization.findById(req.org);
  let vendor = null;
  if (data.vendor) {
    vendor = await Vendor.findOne({ _id: data.vendor, organization: req.org });
    if (!vendor) throw new HttpError(400, "Choose a valid vendor");
  }
  const placeOfSupply = data.placeOfSupply || vendor?.placeOfSupply || org.state;
  const isInterState = placeOfSupply !== org.state;
  const rate = Number(data.taxRate) || 0;
  // If the amount includes GST, work back to the amount before tax.
  const base = data.taxInclusive ? round2(data.amount / (1 + rate / 100)) : round2(data.amount);
  const tax = data.taxInclusive ? round2(data.amount - base) : round2((base * rate) / 100);
  const { taxInclusive, ...rest } = data;
  return {
    ...rest,
    vendor: vendor ? vendor._id : undefined,
    vendorName: vendor ? vendor.displayName : "",
    placeOfSupply,
    isInterState,
    amount: base,
    cgst: isInterState ? 0 : round2(tax / 2),
    sgst: isInterState ? 0 : round2(tax - round2(tax / 2)),
    igst: isInterState ? tax : 0,
    total: round2(base + tax),
  };
}

router.get("/categories", (req, res) => res.send(EXPENSE_CATEGORIES));

router.get(
  "/",
  ah(async (req, res) => {
    const filter = { organization: req.org };
    if (req.query.vendor) filter.vendor = req.query.vendor;
    if (req.query.category && req.query.category !== "all") filter.category = req.query.category;
    if (req.query.q) {
      const rx = escapeRx(req.query.q);
      filter.$or = [{ category: rx }, { vendorName: rx }, { reference: rx }, { notes: rx }];
    }
    res.send(await Expense.find(filter).sort({ date: -1, createdAt: -1 }));
  })
);

router.post(
  "/",
  ah(async (req, res) => {
    const data = validate(schema, req.body);
    res.status(201).send(await Expense.create({ ...(await build(req, data)), organization: req.org }));
  })
);

router.get(
  "/:id",
  ah(async (req, res) => {
    const e = await Expense.findOne({ _id: req.params.id, organization: req.org });
    if (!e) throw new HttpError(404, "Expense not found");
    res.send(e);
  })
);

router.put(
  "/:id",
  ah(async (req, res) => {
    const data = validate(schema, req.body);
    const fields = await build(req, data);
    const e = await Expense.findOne({ _id: req.params.id, organization: req.org });
    if (!e) throw new HttpError(404, "Expense not found");
    e.set(fields);
    if (!fields.vendor) e.vendor = undefined;
    await e.save();
    res.send(e);
  })
);

router.delete(
  "/:id",
  ah(async (req, res) => {
    const r = await Expense.deleteOne({ _id: req.params.id, organization: req.org });
    if (!r.deletedCount) throw new HttpError(404, "Expense not found");
    res.send({ message: "Expense deleted" });
  })
);

module.exports = router;
