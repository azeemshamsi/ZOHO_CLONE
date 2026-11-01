const router = require("express").Router();
const Joi = require("joi");
const Vendor = require("../models/Vendor");
const Bill = require("../models/Bill");
const VendorPayment = require("../models/VendorPayment");
const Expense = require("../models/Expense");
const VendorCredit = require("../models/VendorCredit");
const PurchaseOrder = require("../models/PurchaseOrder");
const { ah, validate, HttpError, round2 } = require("../utils/http");
const { escapeRx } = require("../utils/salesDoc");

const address = Joi.object({
  street: Joi.string().allow(""),
  city: Joi.string().allow(""),
  state: Joi.string().allow(""),
  pincode: Joi.string().allow(""),
  country: Joi.string().allow(""),
});

const schema = Joi.object({
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
  pan: Joi.string()
    .allow("")
    .uppercase()
    .pattern(/^[A-Z]{5}[0-9]{4}[A-Z]$/)
    .messages({ "string.pattern.base": "PAN must look like ABCDE1234F" }),
  placeOfSupply: Joi.string().allow(""),
  currency: Joi.string().uppercase().length(3),
  billingAddress: address,
  paymentTerms: Joi.number().min(0).max(365),
  notes: Joi.string().allow(""),
  active: Joi.boolean(),
});

async function payablesByVendor(org) {
  const bills = await Bill.find({ organization: org, status: { $in: ["open", "partially_paid"] } }, { vendor: 1, balance: 1 }).lean();
  const map = {};
  for (const b of bills) map[String(b.vendor)] = round2((map[String(b.vendor)] || 0) + b.balance);
  return map;
}

router.get(
  "/",
  ah(async (req, res) => {
    const filter = { organization: req.org };
    if (req.query.q) {
      const rx = escapeRx(req.query.q);
      filter.$or = [{ displayName: rx }, { companyName: rx }, { email: rx }, { phone: rx }, { gstin: rx }];
    }
    if (req.query.status === "active") filter.active = true;
    if (req.query.status === "inactive") filter.active = false;
    const [vendors, pay] = await Promise.all([Vendor.find(filter).sort({ displayName: 1 }).lean(), payablesByVendor(req.org)]);
    res.send(vendors.map((v) => ({ ...v, payables: pay[String(v._id)] || 0 })));
  })
);

router.post(
  "/",
  ah(async (req, res) => {
    const data = validate(schema, req.body);
    res.status(201).send(await Vendor.create({ ...data, organization: req.org }));
  })
);

router.get(
  "/:id",
  ah(async (req, res) => {
    const vendor = await Vendor.findOne({ _id: req.params.id, organization: req.org }).lean();
    if (!vendor) throw new HttpError(404, "Vendor not found");
    const [bills, payments, expenses, vendorCredits] = await Promise.all([
      Bill.find({ organization: req.org, vendor: vendor._id }, { lineItems: 0 }).sort({ date: -1 }),
      VendorPayment.find({ organization: req.org, vendor: vendor._id }).sort({ date: -1 }).lean(),
      Expense.find({ organization: req.org, vendor: vendor._id }).sort({ date: -1 }).lean(),
      VendorCredit.find({ organization: req.org, vendor: vendor._id }, { lineItems: 0 }).sort({ date: -1 }).lean(),
    ]);
    const payables = round2(bills.filter((b) => ["open", "partially_paid"].includes(b.status)).reduce((s, b) => s + b.balance, 0));
    const unusedCredits = round2(
      payments.reduce((s, p) => s + (p.unusedAmount || 0), 0) +
        vendorCredits.filter((c) => c.status === "open").reduce((s, c) => s + c.balance, 0)
    );
    res.send({ ...vendor, payables, unusedCredits, bills, payments, expenses, vendorCredits });
  })
);

router.put(
  "/:id",
  ah(async (req, res) => {
    const data = validate(schema, req.body);
    const vendor = await Vendor.findOneAndUpdate({ _id: req.params.id, organization: req.org }, data, { new: true, runValidators: true });
    if (!vendor) throw new HttpError(404, "Vendor not found");
    res.send(vendor);
  })
);

router.delete(
  "/:id",
  ah(async (req, res) => {
    const q = { organization: req.org, vendor: req.params.id };
    const used =
      (await Bill.exists(q)) ||
      (await VendorPayment.exists(q)) ||
      (await Expense.exists(q)) ||
      (await VendorCredit.exists(q)) ||
      (await PurchaseOrder.exists(q));
    if (used) throw new HttpError(400, "This vendor has transactions. Mark them inactive instead of deleting.");
    const r = await Vendor.deleteOne({ _id: req.params.id, organization: req.org });
    if (!r.deletedCount) throw new HttpError(404, "Vendor not found");
    res.send({ message: "Vendor deleted" });
  })
);

module.exports = router;
