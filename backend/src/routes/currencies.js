const router = require("express").Router();
const Joi = require("joi");
const Currency = require("../models/Currency");
const { COMMON } = require("../models/Currency");
const { ah, validate, HttpError } = require("../utils/http");
const { istToday } = require("../utils/time");

router.get("/common", (req, res) => res.send(COMMON.map(([code, symbol, name]) => ({ code, symbol, name }))));
router.get("/", ah(async (req, res) => res.send(await Currency.find({ organization: req.org }).sort({ code: 1 }))));

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
  "/:id",
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
  "/:id",
  ah(async (req, res) => {
    const c = await Currency.findOne({ _id: req.params.id, organization: req.org });
    if (!c) throw new HttpError(404, "Currency not found");
    for (const m of ["Customer", "Vendor"]) if (await require(`../models/${m}`).exists({ organization: req.org, currency: c.code })) throw new HttpError(400, `Some ${m.toLowerCase()}s use ${c.code}`);
    await c.deleteOne();
    res.send({ message: "Currency removed" });
  })
);
module.exports = router;
