const router = require("express").Router();
const Joi = require("joi");
const Payment = require("../models/Payment");
const Invoice = require("../models/Invoice");
const Customer = require("../models/Customer");
const Organization = require("../models/Organization");
const { nextNumber } = require("../models/Counter");
const { settleInvoice: settle } = require("../utils/salesDoc");
const { ah, validate, HttpError, round2 } = require("../utils/http");

const schema = Joi.object({
  customer: Joi.string().required().label("Customer"),
  date: Joi.date().required().label("Payment date"),
  amount: Joi.number().greater(0).required().label("Amount received"),
  mode: Joi.string().valid("cash", "bank_transfer", "upi", "cheque", "card", "other"),
  reference: Joi.string().allow(""),
  bankAccount: Joi.string().allow(""),
  notes: Joi.string().allow(""),
  exchangeRate: Joi.number().greater(0),
  allocations: Joi.array()
    .items(Joi.object({ invoice: Joi.string().required(), amount: Joi.number().min(0).required() }))
    .default([]),
});

router.get(
  "/",
  ah(async (req, res) => {
    const filter = { organization: req.org };
    if (req.query.customer) filter.customer = req.query.customer;
    if (req.query.q) {
      const rx = new RegExp(req.query.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ paymentNumber: rx }, { customerName: rx }, { reference: rx }];
    }
    res.send(await Payment.find(filter).sort({ date: -1, createdAt: -1 }));
  })
);

router.post(
  "/",
  ah(async (req, res) => {
    const data = validate(schema, req.body);
    if (!(await require("../utils/ledger").isBankAccount(req.org, data.bankAccount))) throw new HttpError(400, "Pick a cash or bank account");
    const customer = await Customer.findOne({ _id: data.customer, organization: req.org });
    if (!customer) throw new HttpError(400, "Choose a valid customer");

    const allocations = data.allocations.filter((a) => a.amount > 0);
    const allocated = round2(allocations.reduce((s, a) => s + a.amount, 0));
    if (allocated > round2(data.amount)) {
      throw new HttpError(400, "The amounts applied to invoices are more than the amount received");
    }

    const invoices = [];
    for (const a of allocations) {
      const inv = await Invoice.findOne({ _id: a.invoice, organization: req.org, customer: customer._id });
      if (!inv || inv.status === "void") throw new HttpError(400, "One of the selected invoices is not valid");
      if (round2(a.amount) > inv.balance) {
        throw new HttpError(400, `Payment for ${inv.invoiceNumber} is more than its balance due`);
      }
      invoices.push([inv, round2(a.amount)]);
    }

    const org = await Organization.findById(req.org);
    const payment = await Payment.create({
      ...data,
      organization: req.org,
      customerName: customer.displayName,
      paymentNumber: await nextNumber(req.org, ...(await require("../utils/salesDoc").branchSeries("payment", org.paymentPrefix || "PAY-", invoices[0]?.[0].branch))),
      allocations: invoices.map(([inv, amount]) => ({ invoice: inv._id, invoiceNumber: inv.invoiceNumber, amount })),
      unusedAmount: round2(data.amount - allocated),
      branch: invoices[0]?.[0].branch || null, // follows the branch of the invoices it pays
      ...(await require("../utils/salesDoc").currencyFor(req, customer, data.exchangeRate)),
    });

    for (const [inv, amount] of invoices) {
      if (inv.status === "draft") inv.status = "sent";
      inv.amountPaid = round2(inv.amountPaid + amount);
      settle(inv);
      await inv.save();
    }
    res.status(201).send(payment);
  })
);

router.get(
  "/:id",
  ah(async (req, res) => {
    const payment = await Payment.findOne({ _id: req.params.id, organization: req.org });
    if (!payment) throw new HttpError(404, "Payment not found");
    res.send(payment);
  })
);

router.delete(
  "/:id",
  ah(async (req, res) => {
    const payment = await Payment.findOne({ _id: req.params.id, organization: req.org });
    if (!payment) throw new HttpError(404, "Payment not found");
    for (const a of payment.allocations) {
      const inv = await Invoice.findOne({ _id: a.invoice, organization: req.org });
      if (!inv) continue;
      inv.amountPaid = round2(Math.max(inv.amountPaid - a.amount, 0));
      if (inv.status === "paid" || inv.status === "partially_paid") inv.status = "sent";
      settle(inv);
      await inv.save();
    }
    await payment.deleteOne();
    res.send({ message: "Payment deleted" });
  })
);

module.exports = router;
