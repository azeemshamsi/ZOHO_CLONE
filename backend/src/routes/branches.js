const router = require("express").Router();
const Joi = require("joi");
const Branch = require("../models/Branch");
const { ah, validate, HttpError } = require("../utils/http");

const address = Joi.object({ street: Joi.string().allow(""), city: Joi.string().allow(""), state: Joi.string().allow(""), pincode: Joi.string().allow(""), country: Joi.string().allow("") });
const schema = Joi.object({
  name: Joi.string().trim().required().label("Branch name"),
  code: Joi.string().allow(""),
  gstin: Joi.string().allow("").uppercase().pattern(/^[0-9]{2}[A-Z0-9]{13}$/).messages({ "string.pattern.base": "GSTIN must be 15 characters" }),
  state: Joi.string().required().label("State"),
  address: address.default({}),
  email: Joi.string().allow(""),
  phone: Joi.string().allow(""),
  active: Joi.boolean(),
});
const check = (d) => {
  if (d.gstin && d.gstin.slice(0, 2) !== d.state) throw new HttpError(400, "The GSTIN's first two digits must match the branch's state code");
  d.address = { ...d.address, state: d.state };
  return d;
};

router.get("/", ah(async (req, res) => res.send(await Branch.find({ organization: req.org }).sort({ name: 1 }))));
router.post("/", ah(async (req, res) => res.status(201).send(await Branch.create({ ...check(validate(schema, req.body)), organization: req.org }))));
router.put(
  "/:id",
  ah(async (req, res) => {
    const b = await Branch.findOneAndUpdate({ _id: req.params.id, organization: req.org }, check(validate(schema, req.body)), { new: true });
    if (!b) throw new HttpError(404, "Branch not found");
    res.send(b);
  })
);
router.delete(
  "/:id",
  ah(async (req, res) => {
    const models = ["Invoice", "Bill", "Expense", "Payment", "VendorPayment", "Journal", "Quote", "SalesOrder", "CreditNote", "PurchaseOrder", "VendorCredit"];
    for (const m of models) if (await require(`../models/${m}`).exists({ organization: req.org, branch: req.params.id })) throw new HttpError(400, "This branch has transactions. Mark it inactive instead.");
    const r = await Branch.deleteOne({ _id: req.params.id, organization: req.org });
    if (!r.deletedCount) throw new HttpError(404, "Branch not found");
    res.send({ message: "Branch deleted" });
  })
);
module.exports = router;
