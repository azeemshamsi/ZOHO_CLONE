const router = require("express").Router();
const Joi = require("joi");
const Item = require("../models/Item");
const Invoice = require("../models/Invoice");
const { ah, validate, HttpError } = require("../utils/http");

const GST_RATES = [0, 0.25, 3, 5, 12, 18, 28];

const schema = Joi.object({
  type: Joi.string().valid("goods", "service"),
  name: Joi.string().trim().min(1).max(200).required().label("Name"),
  sku: Joi.string().allow(""),
  unit: Joi.string().allow(""),
  hsnSac: Joi.string().allow("").label("HSN/SAC"),
  rate: Joi.number().min(0).required().label("Selling price"),
  purchaseRate: Joi.number().min(0),
  taxRate: Joi.number()
    .valid(...GST_RATES)
    .label("GST rate"),
  description: Joi.string().allow(""),
  active: Joi.boolean(),
});

router.get(
  "/",
  ah(async (req, res) => {
    const filter = { organization: req.org };
    if (req.query.q) {
      const rx = new RegExp(req.query.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ name: rx }, { sku: rx }, { hsnSac: rx }];
    }
    if (req.query.status === "active") filter.active = true;
    if (req.query.status === "inactive") filter.active = false;
    res.send(await Item.find(filter).sort({ name: 1 }));
  })
);

router.post(
  "/",
  ah(async (req, res) => {
    const data = validate(schema, req.body);
    res.status(201).send(await Item.create({ ...data, organization: req.org }));
  })
);

router.get(
  "/:id",
  ah(async (req, res) => {
    const item = await Item.findOne({ _id: req.params.id, organization: req.org });
    if (!item) throw new HttpError(404, "Item not found");
    res.send(item);
  })
);

router.put(
  "/:id",
  ah(async (req, res) => {
    const data = validate(schema, req.body);
    const item = await Item.findOneAndUpdate({ _id: req.params.id, organization: req.org }, data, {
      new: true,
      runValidators: true,
    });
    if (!item) throw new HttpError(404, "Item not found");
    res.send(item);
  })
);

router.delete(
  "/:id",
  ah(async (req, res) => {
    const q = { organization: req.org, "lineItems.item": req.params.id };
    const used =
      (await Invoice.exists(q)) ||
      (await require("../models/Quote").exists(q)) ||
      (await require("../models/SalesOrder").exists(q)) ||
      (await require("../models/CreditNote").exists(q));
    if (used) throw new HttpError(400, "This item is used in transactions. Mark it inactive instead of deleting.");
    const r = await Item.deleteOne({ _id: req.params.id, organization: req.org });
    if (!r.deletedCount) throw new HttpError(404, "Item not found");
    res.send({ message: "Item deleted" });
  })
);

module.exports = router;
module.exports.GST_RATES = GST_RATES;
