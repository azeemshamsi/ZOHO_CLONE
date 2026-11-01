const router = require("express").Router();
const Joi = require("joi");
const Currency = require("../models/Currency");
const { COMMON } = require("../models/Currency");
const { ah, validate, HttpError } = require("../utils/http");
const { istToday } = require("../utils/time");

router.get("/common", (req, res) => res.send(COMMON.map(([code, symbol, name]) => ({ code, symbol, name }))));
router.get("/", ah(async (req, res) => res.send(await Currency.find({ organization: req.org }).sort({ code: 1 }))));

// Fetch today's rates for every currency.
router.post(
  "/refresh",
  ah(async (req, res) => {
    let r;
    try {
      r = await require("../utils/fx").refreshOrg(req.org);
    } catch (e) {
      throw new HttpError(502, `Couldn't reach the exchange rate service (${e.message}). Enter rates by hand for now.`);
    }
    await require("../models/Organization").updateOne({ _id: req.org }, { fxUpdatedAt: new Date() });
    res.send(r);
  })
);

router.put(
  "/settings",
  ah(async (req, res) => {
    const { autoUpdate } = validate(Joi.object({ autoUpdate: Joi.boolean().required() }), req.body);
    const org = await require("../models/Organization").findByIdAndUpdate(req.org, { fxAutoUpdate: autoUpdate }, { new: true });
    res.send(org);
  })
);

/* ---- Exchange rate adjustments (revaluation) ---- */
const ExchangeAdjustment = require("../models/ExchangeAdjustment");
const adjSchema = Joi.object({ currency: Joi.string().uppercase().length(3).required(), date: Joi.date().required(), rate: Joi.number().greater(0).required(), notes: Joi.string().allow("") });

router.get("/adjustments", ah(async (req, res) => res.send(await ExchangeAdjustment.find({ organization: req.org }).sort({ date: -1 }))));
router.get(
  "/adjustments/preview",
  ah(async (req, res) => {
    const d = validate(adjSchema, req.query);
    res.send(await require("../utils/fx").revaluation(req.org, d.currency, d.date, d.rate));
  })
);
router.post(
  "/adjustments",
  ah(async (req, res) => {
    const d = validate(adjSchema, req.body);
    if (await ExchangeAdjustment.exists({ organization: req.org, currency: d.currency, date: d.date })) throw new HttpError(409, `${d.currency} is already revalued on that date`);
    const r = await require("../utils/fx").revaluation(req.org, d.currency, d.date, d.rate);
    if (!r.lines.length) throw new HttpError(400, `No open ${d.currency} invoices or bills on that date`);
    res.status(201).send(await ExchangeAdjustment.create({ ...d, ...r, organization: req.org }));
  })
);
router.delete(
  "/adjustments/:id",
  ah(async (req, res) => {
    const r = await ExchangeAdjustment.deleteOne({ _id: req.params.id, organization: req.org });
    if (!r.deletedCount) throw new HttpError(404, "Adjustment not found");
    res.send({ message: "Adjustment deleted" });
  })
);

const schema = Joi.object({
  code: Joi.string().uppercase().length(3).required().label("Currency code"),
  symbol: Joi.string().allow(""),
  name: Joi.string().allow(""),
  rate: Joi.number().greater(0).required().label("Exchange rate"),
});

router.post(
  "/",
  ah(async (req, res) => {
    const d = validate(schema, req.body);
    if (d.code === "INR") throw new HttpError(400, "INR is your base currency");
    if (await Currency.exists({ organization: req.org, code: d.code })) throw new HttpError(409, `${d.code} is already added`);
    res.status(201).send(await Currency.create({ ...d, organization: req.org, rates: [{ date: istToday(), rate: d.rate }] }));
  })
);

router.put(
  "/:id([0-9a-f]{24})",
  ah(async (req, res) => {
    const d = validate(schema, req.body);
    const c = await Currency.findOne({ _id: req.params.id, organization: req.org });
    if (!c) throw new HttpError(404, "Currency not found");
    if (d.rate !== c.rate) c.rates.push({ date: istToday(), rate: d.rate });
    c.set({ symbol: d.symbol, name: d.name, rate: d.rate });
    await c.save();
    res.send(c);
  })
);

router.delete(
  "/:id([0-9a-f]{24})",
  ah(async (req, res) => {
    const c = await Currency.findOne({ _id: req.params.id, organization: req.org });
    if (!c) throw new HttpError(404, "Currency not found");
    for (const m of ["Customer", "Vendor"]) if (await require(`../models/${m}`).exists({ organization: req.org, currency: c.code })) throw new HttpError(400, `Some ${m.toLowerCase()}s use ${c.code}`);
    await c.deleteOne();
    res.send({ message: "Currency removed" });
  })
);
module.exports = router;
