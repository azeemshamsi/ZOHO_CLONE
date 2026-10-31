const router = require("express").Router();
const Joi = require("joi");
const Customer = require("../models/Customer");
const Invoice = require("../models/Invoice");
const Payment = require("../models/Payment");
const { ah, validate, HttpError, round2 } = require("../utils/http");

const address = Joi.object({
  street: Joi.string().allow(""),
  city: Joi.string().allow(""),
  state: Joi.string().allow(""),
  pincode: Joi.string().allow(""),
  country: Joi.string().allow(""),
});

const schema = Joi.object({
  customerType: Joi.string().valid("business", "individual"),
  displayName: Joi.string().trim().min(1).max(200).required().label("Display name"),
  companyName: Joi.string().allow(""),
  firstName: Joi.string().allow(""),
  lastName: Joi.string().allow(""),
  email: Joi.string().email().allow("").label("Email"),
  phone: Joi.string().allow(""),
  gstTreatment: Joi.string().valid("registered", "unregistered", "consumer", "overseas", "sez"),
  gstin: Joi.string()
    .allow("")
    .uppercase()
    .pattern(/^[0-9]{2}[A-Z0-9]{13}$/)
    .messages({ "string.pattern.base": "GSTIN must be 15 characters" }),
  placeOfSupply: Joi.string().allow(""),
  billingAddress: address,
  shippingAddress: address,
  paymentTerms: Joi.number().min(0).max(365),
  notes: Joi.string().allow(""),
  active: Joi.boolean(),
});

// Outstanding receivable per customer.
async function receivablesByCustomer(org) {
  const invoices = await Invoice.find(
    { organization: org, status: { $in: ["sent", "partially_paid"] } },
    { customer: 1, balance: 1 }
  ).lean();
  const map = {};
  for (const inv of invoices) {
    const k = String(inv.customer);
    map[k] = round2((map[k] || 0) + inv.balance);
  }
  return map;
}

router.get(
  "/",
  ah(async (req, res) => {
    const filter = { organization: req.org };
    if (req.query.q) {
      const rx = new RegExp(req.query.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ displayName: rx }, { companyName: rx }, { email: rx }, { phone: rx }];
    }
    if (req.query.status === "active") filter.active = true;
    if (req.query.status === "inactive") filter.active = false;
    const [customers, recv] = await Promise.all([
      Customer.find(filter).sort({ displayName: 1 }).lean(),
      receivablesByCustomer(req.org),
    ]);
    res.send(customers.map((c) => ({ ...c, receivables: recv[String(c._id)] || 0 })));
  })
);

router.post(
  "/",
  ah(async (req, res) => {
    const data = validate(schema, req.body);
    const customer = await Customer.create({ ...data, organization: req.org });
    res.status(201).send(customer);
  })
);

router.get(
  "/:id",
  ah(async (req, res) => {
    const customer = await Customer.findOne({ _id: req.params.id, organization: req.org }).lean();
    if (!customer) throw new HttpError(404, "Customer not found");
    const [invoices, payments] = await Promise.all([
      Invoice.find({ organization: req.org, customer: customer._id }).sort({ date: -1 }),
      Payment.find({ organization: req.org, customer: customer._id }).sort({ date: -1 }).lean(),
    ]);
    const receivables = round2(
      invoices.filter((i) => ["sent", "partially_paid"].includes(i.status)).reduce((s, i) => s + i.balance, 0)
    );
    const unusedCredits = round2(payments.reduce((s, p) => s + (p.unusedAmount || 0), 0));
    res.send({ ...customer, receivables, unusedCredits, invoices, payments });
  })
);

router.put(
  "/:id",
  ah(async (req, res) => {
    const data = validate(schema, req.body);
    const customer = await Customer.findOneAndUpdate({ _id: req.params.id, organization: req.org }, data, {
      new: true,
      runValidators: true,
    });
    if (!customer) throw new HttpError(404, "Customer not found");
    res.send(customer);
  })
);

router.delete(
  "/:id",
  ah(async (req, res) => {
    const used = await Invoice.exists({ organization: req.org, customer: req.params.id });
    if (used) throw new HttpError(400, "This customer has invoices. Mark them inactive instead of deleting.");
    const r = await Customer.deleteOne({ _id: req.params.id, organization: req.org });
    if (!r.deletedCount) throw new HttpError(404, "Customer not found");
    res.send({ message: "Customer deleted" });
  })
);

module.exports = router;
