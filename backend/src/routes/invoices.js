const router = require("express").Router();
const Joi = require("joi");
const Invoice = require("../models/Invoice");
const Organization = require("../models/Organization");
const Payment = require("../models/Payment");
const CreditNote = require("../models/CreditNote");
const { ah, validate, HttpError } = require("../utils/http");
const { baseDocJoi, prepareDoc, peekNumber, settleInvoice, escapeRx, nextNumber } = require("../utils/salesDoc");

const schema = Joi.object({
  ...baseDocJoi,
  date: Joi.date().required().label("Invoice date"),
  invoiceNumber: Joi.string().trim().allow(""),
  orderNumber: Joi.string().allow(""),
  paymentTerms: Joi.number().min(0).max(365),
  dueDate: Joi.date().required().label("Due date"),
  status: Joi.string().valid("draft", "sent"),
});

async function build(req, data) {
  const out = await prepareDoc(req, data);
  if (new Date(data.dueDate) < new Date(new Date(data.date).toDateString())) {
    throw new HttpError(400, "Due date can't be before the invoice date");
  }
  return out;
}

// Invoices with a live IRN can't be changed in OrdexaGo: cancel the e-invoice first.
const blockIfEInvoiced = (doc) => {
  if (doc.einvoice && doc.einvoice.status === "generated") throw new HttpError(400, "This document has an e-invoice (IRN). Cancel the e-invoice first, then edit or void it.");
};

router.get(
  "/",
  ah(async (req, res) => {
    const filter = { organization: req.org };
    if (req.query.customer) filter.customer = req.query.customer;
    if (req.query.open === "1") filter.status = { $in: ["draft", "sent", "partially_paid"] };
    if (req.query.q) {
      const rx = escapeRx(req.query.q);
      filter.$or = [{ invoiceNumber: rx }, { customerName: rx }, { orderNumber: rx }];
    }
    let invoices = await Invoice.find(filter, { lineItems: 0 }).sort({ date: -1, createdAt: -1 });
    const s = req.query.status;
    if (s && s !== "all") {
      invoices = invoices.filter((i) =>
        s === "unpaid" ? i.balance > 0 && !["void", "draft"].includes(i.status) : i.displayStatus === s
      );
    }
    res.send(invoices);
  })
);

router.get(
  "/next-number",
  ah(async (req, res) => {
    const org = await Organization.findById(req.org);
    res.send({ number: await peekNumber(req.org, ...(await require("../utils/salesDoc").branchSeries("invoice", org.invoicePrefix || "INV-", req.query.branch))) });
  })
);

router.post(
  "/",
  ah(async (req, res) => res.status(201).send(await createInvoice(req, req.body)))
);

router.get(
  "/:id",
  ah(async (req, res) => {
    const invoice = await Invoice.findOne({ _id: req.params.id, organization: req.org });
    if (!invoice) throw new HttpError(404, "Invoice not found");
    const [payments, credits] = await Promise.all([
      Payment.find({ organization: req.org, "allocations.invoice": invoice._id }).lean(),
      CreditNote.find({ organization: req.org, "applications.invoice": invoice._id }).lean(),
    ]);
    const mine = (list) => list.filter((a) => String(a.invoice) === String(invoice._id)).reduce((s, a) => s + a.amount, 0);
    res.send({
      ...invoice.toJSON(),
      payments: payments.map((p) => ({
        _id: p._id,
        paymentNumber: p.paymentNumber,
        date: p.date,
        mode: p.mode,
        reference: p.reference,
        amount: mine(p.allocations),
      })),
      credits: credits.map((c) => ({ _id: c._id, number: c.number, date: c.date, amount: mine(c.applications) })),
    });
  })
);

router.put(
  "/:id",
  ah(async (req, res) => {
    const invoice = await Invoice.findOne({ _id: req.params.id, organization: req.org });
    if (invoice) blockIfEInvoiced(invoice);
    if (!invoice) throw new HttpError(404, "Invoice not found");
    if (invoice.status === "void") throw new HttpError(400, "A void invoice can't be edited");
    const data = validate(schema, req.body);
    const { fields } = await build(req, data);
    if (!fields.invoiceNumber) fields.invoiceNumber = invoice.invoiceNumber;
    if (fields.total < invoice.amountPaid + invoice.creditsApplied) {
      throw new HttpError(400, "The new total is less than the payments and credits already applied to this invoice");
    }
    const status = invoice.status === "draft" ? data.status || "draft" : invoice.status;
    invoice.set({ ...fields, status });
    settleInvoice(invoice);
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
      settleInvoice(invoice);
      await invoice.save();
    }
    res.send(invoice);
  })
);

const blockIfMoneyApplied = (invoice, action) => {
  if (invoice.amountPaid > 0) throw new HttpError(400, `Delete the payments on this invoice before ${action} it`);
  if (invoice.creditsApplied > 0) throw new HttpError(400, `Remove the credits applied to this invoice before ${action} it`);
};

router.post(
  "/:id/void",
  ah(async (req, res) => {
    const invoice = await Invoice.findOne({ _id: req.params.id, organization: req.org });
    if (!invoice) throw new HttpError(404, "Invoice not found");
    blockIfMoneyApplied(invoice, "voiding");
    blockIfEInvoiced(invoice);
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
    blockIfMoneyApplied(invoice, "deleting");
    blockIfEInvoiced(invoice);
    // Free up the quote / sales order it came from.
    const Quote = require("../models/Quote");
    const SalesOrder = require("../models/SalesOrder");
    await Promise.all([
      Quote.updateMany(
        { organization: req.org, "convertedTo.id": invoice._id },
        { $set: { status: "accepted" }, $unset: { convertedTo: 1 } }
      ),
      SalesOrder.updateMany(
        { organization: req.org, invoice: invoice._id },
        { $set: { status: "confirmed", invoiceNumber: "" }, $unset: { invoice: 1 } }
      ),
    ]);
    await invoice.deleteOne();
    res.send({ message: "Invoice deleted" });
  })
);

// Shared with recurring invoices.
async function createInvoice(req, body) {
  const data = validate(schema, body);
  const { org, fields } = await build(req, data);
  if (!fields.invoiceNumber) fields.invoiceNumber = await nextNumber(req.org, ...(await require("../utils/salesDoc").branchSeries("invoice", org.invoicePrefix || "INV-", fields.branch)));
  const invoice = new Invoice({ ...fields, organization: req.org, status: data.status || "draft" });
  settleInvoice(invoice);
  await invoice.save();
  return invoice;
}

module.exports = router;
module.exports.schema = schema;
module.exports.createInvoice = createInvoice;
module.exports.settle = settleInvoice;
