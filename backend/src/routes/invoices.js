const router = require("express").Router();
const Joi = require("joi");
const Invoice = require("../models/Invoice");
const Customer = require("../models/Customer");
const Organization = require("../models/Organization");
const Payment = require("../models/Payment");
const { nextNumber } = require("../models/Counter");
const { computeTotals } = require("../utils/gst");
const { ah, validate, HttpError, round2 } = require("../utils/http");

const lineItem = Joi.object({
  item: Joi.string().allow(null, ""),
  name: Joi.string().trim().min(1).required().label("Item name"),
  description: Joi.string().allow(""),
  hsnSac: Joi.string().allow(""),
  unit: Joi.string().allow(""),
  quantity: Joi.number().greater(0).required().label("Quantity"),
  rate: Joi.number().min(0).required().label("Rate"),
  discount: Joi.number().min(0).max(100),
  taxRate: Joi.number().min(0).max(100),
});

const schema = Joi.object({
  customer: Joi.string().required().label("Customer"),
  invoiceNumber: Joi.string().trim().allow(""),
  orderNumber: Joi.string().allow(""),
  date: Joi.date().required().label("Invoice date"),
  paymentTerms: Joi.number().min(0).max(365),
  dueDate: Joi.date().required().label("Due date"),
  placeOfSupply: Joi.string().allow(""),
  lineItems: Joi.array().items(lineItem).min(1).required().label("Items"),
  shippingCharge: Joi.number().min(0),
  adjustment: Joi.number(),
  customerNotes: Joi.string().allow(""),
  terms: Joi.string().allow(""),
  status: Joi.string().valid("draft", "sent"),
});

// Bring status and balance in line with amounts.
function settle(inv) {
  inv.amountPaid = round2(inv.amountPaid || 0);
  inv.balance = round2(Math.max(inv.total - inv.amountPaid, 0));
  if (inv.status === "void") return inv;
  if (inv.amountPaid > 0 && inv.balance === 0) inv.status = "paid";
  else if (inv.amountPaid > 0) inv.status = "partially_paid";
  else if (inv.status !== "draft") inv.status = "sent";
  return inv;
}

async function buildInvoice(req, data) {
  const [customer, org] = await Promise.all([
    Customer.findOne({ _id: data.customer, organization: req.org }),
    Organization.findById(req.org),
  ]);
  if (!customer) throw new HttpError(400, "Choose a valid customer");
  const placeOfSupply = data.placeOfSupply || customer.placeOfSupply || org.state;
  const totals = computeTotals({
    lineItems: data.lineItems.map((l) => ({ ...l, item: l.item || undefined })),
    orgState: org.state,
    placeOfSupply,
    shippingCharge: data.shippingCharge,
    adjustment: data.adjustment,
  });
  if (new Date(data.dueDate) < new Date(new Date(data.date).toDateString())) {
    throw new HttpError(400, "Due date can't be before the invoice date");
  }
  return {
    org,
    fields: {
      ...data,
      ...totals,
      placeOfSupply,
      customerName: customer.displayName,
      customerGstin: customer.gstin,
      billingAddress: customer.billingAddress,
    },
  };
}

router.get(
  "/",
  ah(async (req, res) => {
    const filter = { organization: req.org };
    if (req.query.customer) filter.customer = req.query.customer;
    if (req.query.open === "1") filter.status = { $in: ["draft", "sent", "partially_paid"] };
    if (req.query.q) {
      const rx = new RegExp(req.query.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ invoiceNumber: rx }, { customerName: rx }, { orderNumber: rx }];
    }
    let invoices = await Invoice.find(filter, { lineItems: 0 }).sort({ date: -1, createdAt: -1 });
    const s = req.query.status;
    if (s && s !== "all") {
      invoices = invoices.filter((i) => (s === "unpaid" ? i.balance > 0 && i.status !== "void" && i.status !== "draft" : i.displayStatus === s));
    }
    res.send(invoices);
  })
);

router.get(
  "/next-number",
  ah(async (req, res) => {
    const org = await Organization.findById(req.org);
    const { Counter } = require("../models/Counter");
    const c = await Counter.findOne({ organization: req.org, key: "invoice" });
    res.send({ invoiceNumber: `${org.invoicePrefix}${String((c ? c.seq : 0) + 1).padStart(6, "0")}` });
  })
);

router.post(
  "/",
  ah(async (req, res) => {
    const data = validate(schema, req.body);
    const { org, fields } = await buildInvoice(req, data);
    if (!fields.invoiceNumber) fields.invoiceNumber = await nextNumber(req.org, "invoice", org.invoicePrefix);
    const invoice = new Invoice({ ...fields, organization: req.org, status: data.status || "draft" });
    settle(invoice);
    await invoice.save();
    res.status(201).send(invoice);
  })
);

router.get(
  "/:id",
  ah(async (req, res) => {
    const invoice = await Invoice.findOne({ _id: req.params.id, organization: req.org });
    if (!invoice) throw new HttpError(404, "Invoice not found");
    const payments = await Payment.find(
      { organization: req.org, "allocations.invoice": invoice._id },
      { paymentNumber: 1, date: 1, mode: 1, reference: 1, allocations: 1 }
    ).lean();
    const paymentHistory = payments.map((p) => ({
      _id: p._id,
      paymentNumber: p.paymentNumber,
      date: p.date,
      mode: p.mode,
      reference: p.reference,
      amount: p.allocations.filter((a) => String(a.invoice) === String(invoice._id)).reduce((s, a) => s + a.amount, 0),
    }));
    res.send({ ...invoice.toJSON(), payments: paymentHistory });
  })
);

router.put(
  "/:id",
  ah(async (req, res) => {
    const invoice = await Invoice.findOne({ _id: req.params.id, organization: req.org });
    if (!invoice) throw new HttpError(404, "Invoice not found");
    if (invoice.status === "void") throw new HttpError(400, "A void invoice can't be edited");
    const data = validate(schema, req.body);
    const { fields } = await buildInvoice(req, data);
    if (!fields.invoiceNumber) fields.invoiceNumber = invoice.invoiceNumber;
    if (fields.total < invoice.amountPaid) {
      throw new HttpError(400, "The new total is less than the amount already paid on this invoice");
    }
    const status = invoice.status === "draft" ? data.status || "draft" : invoice.status;
    invoice.set({ ...fields, status });
    settle(invoice);
    await invoice.save();
    res.send(invoice);
  })
);

router.post(
  "/:id/send",
  ah(async (req, res) => {
    const invoice = await Invoice.findOne({ _id: req.params.id, organization: req.org });
    if (!invoice) throw new HttpError(404, "Invoice not found");
    if (invoice.status === "draft") {
      invoice.status = "sent";
      settle(invoice);
      await invoice.save();
    }
    res.send(invoice);
  })
);

router.post(
  "/:id/void",
  ah(async (req, res) => {
    const invoice = await Invoice.findOne({ _id: req.params.id, organization: req.org });
    if (!invoice) throw new HttpError(404, "Invoice not found");
    if (invoice.amountPaid > 0) throw new HttpError(400, "Delete the payments on this invoice before voiding it");
    invoice.status = "void";
    invoice.balance = 0;
    await invoice.save();
    res.send(invoice);
  })
);

router.delete(
  "/:id",
  ah(async (req, res) => {
    const invoice = await Invoice.findOne({ _id: req.params.id, organization: req.org });
    if (!invoice) throw new HttpError(404, "Invoice not found");
    if (invoice.amountPaid > 0) throw new HttpError(400, "Delete the payments on this invoice before deleting it");
    await invoice.deleteOne();
    res.send({ message: "Invoice deleted" });
  })
);

module.exports = router;
module.exports.settle = settle;
