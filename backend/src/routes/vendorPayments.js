const router = require("express").Router();
const Joi = require("joi");
const VendorPayment = require("../models/VendorPayment");
const Bill = require("../models/Bill");
const Vendor = require("../models/Vendor");
const Organization = require("../models/Organization");
const { nextNumber } = require("../models/Counter");
const { ah, validate, HttpError, round2 } = require("../utils/http");
const { settleBill, escapeRx } = require("../utils/salesDoc");

const schema = Joi.object({
  vendor: Joi.string().required().label("Vendor"),
  date: Joi.date().required().label("Payment date"),
  amount: Joi.number().greater(0).required().label("Amount paid"),
  mode: Joi.string().valid("cash", "bank_transfer", "upi", "cheque", "card", "other"),
  reference: Joi.string().allow(""),
  bankAccount: Joi.string().allow(""),
  notes: Joi.string().allow(""),
  exchangeRate: Joi.number().greater(0),
  allocations: Joi.array()
    .items(Joi.object({ bill: Joi.string().required(), amount: Joi.number().min(0).required() }))
    .default([]),
});

router.get(
  "/",
  ah(async (req, res) => {
    const filter = { organization: req.org };
    if (req.query.vendor) filter.vendor = req.query.vendor;
    if (req.query.q) {
      const rx = escapeRx(req.query.q);
      filter.$or = [{ paymentNumber: rx }, { vendorName: rx }, { reference: rx }];
    }
    res.send(await VendorPayment.find(filter).sort({ date: -1, createdAt: -1 }));
  })
);

router.post(
  "/",
  ah(async (req, res) => {
    const data = validate(schema, req.body);
    if (!(await require("../utils/ledger").isBankAccount(req.org, data.bankAccount))) throw new HttpError(400, "Pick a cash or bank account");
    const vendor = await Vendor.findOne({ _id: data.vendor, organization: req.org });
    if (!vendor) throw new HttpError(400, "Choose a valid vendor");

    const allocations = data.allocations.filter((a) => a.amount > 0);
    const allocated = round2(allocations.reduce((s, a) => s + a.amount, 0));
    if (allocated > round2(data.amount)) throw new HttpError(400, "The amounts applied to bills are more than the amount paid");

    const bills = [];
    for (const a of allocations) {
      const bill = await Bill.findOne({ _id: a.bill, organization: req.org, vendor: vendor._id });
      if (!bill || ["void", "draft"].includes(bill.status)) throw new HttpError(400, "One of the selected bills is not valid");
      if (round2(a.amount) > bill.balance) throw new HttpError(400, `Payment for bill ${bill.billNumber} is more than its balance due`);
      bills.push([bill, round2(a.amount)]);
    }

    const org = await Organization.findById(req.org);
    const payment = await VendorPayment.create({
      ...data,
      organization: req.org,
      vendorName: vendor.displayName,
      paymentNumber: await nextNumber(req.org, ...(await require("../utils/salesDoc").branchSeries("vendorPayment", org.vendorPaymentPrefix || "PM-", bills[0]?.[0].branch))),
      allocations: bills.map(([b, amount]) => ({ bill: b._id, billNumber: b.billNumber, amount })),
      unusedAmount: round2(data.amount - allocated),
      branch: bills[0]?.[0].branch || null,
      ...(await require("../utils/salesDoc").currencyFor(req, vendor, data.exchangeRate)),
    });
    for (const [bill, amount] of bills) {
      bill.amountPaid = round2(bill.amountPaid + amount);
      settleBill(bill);
      await bill.save();
    }
    res.status(201).send(payment);
  })
);

router.get(
  "/:id",
  ah(async (req, res) => {
    const p = await VendorPayment.findOne({ _id: req.params.id, organization: req.org });
    if (!p) throw new HttpError(404, "Payment not found");
    res.send(p);
  })
);

router.delete(
  "/:id",
  ah(async (req, res) => {
    const p = await VendorPayment.findOne({ _id: req.params.id, organization: req.org });
    if (!p) throw new HttpError(404, "Payment not found");
    for (const a of p.allocations) {
      const bill = await Bill.findOne({ _id: a.bill, organization: req.org });
      if (!bill) continue;
      bill.amountPaid = round2(Math.max(bill.amountPaid - a.amount, 0));
      if (["paid", "partially_paid"].includes(bill.status)) bill.status = "open";
      settleBill(bill);
      await bill.save();
    }
    await p.deleteOne();
    res.send({ message: "Payment deleted" });
  })
);

module.exports = router;
