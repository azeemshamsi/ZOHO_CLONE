const router = require("express").Router();
const Joi = require("joi");
const Quote = require("../models/Quote");
const SalesOrder = require("../models/SalesOrder");
const Invoice = require("../models/Invoice");
const Organization = require("../models/Organization");
const { ah, validate, HttpError } = require("../utils/http");
const { baseDocJoi, prepareDoc, peekNumber, copyContent, createInvoiceFrom, escapeRx, nextNumber } = require("../utils/salesDoc");

const schema = Joi.object({
  ...baseDocJoi,
  date: Joi.date().required().label("Quote date"),
  number: Joi.string().trim().allow(""),
  reference: Joi.string().allow(""),
  expiryDate: Joi.date().allow(null, ""),
  status: Joi.string().valid("draft", "sent"),
});

const prefix = (org) => org.quotePrefix || "QT-";

async function findQuote(req) {
  const q = await Quote.findOne({ _id: req.params.id, organization: req.org });
  if (!q) throw new HttpError(404, "Quote not found");
  return q;
}

router.get(
  "/",
  ah(async (req, res) => {
    const filter = { organization: req.org };
    if (req.query.customer) filter.customer = req.query.customer;
    if (req.query.q) {
      const rx = escapeRx(req.query.q);
      filter.$or = [{ number: rx }, { customerName: rx }, { reference: rx }];
    }
    let rows = await Quote.find(filter, { lineItems: 0 }).sort({ date: -1, createdAt: -1 });
    const s = req.query.status;
    if (s && s !== "all") rows = rows.filter((r) => r.displayStatus === s);
    res.send(rows);
  })
);

router.get(
  "/next-number",
  ah(async (req, res) => {
    const org = await Organization.findById(req.org);
    res.send({ number: await peekNumber(req.org, ...(await require("../utils/salesDoc").branchSeries("quote", prefix(org), req.query.branch))) });
  })
);

router.post(
  "/",
  ah(async (req, res) => {
    const data = validate(schema, req.body);
    const { org, fields } = await prepareDoc(req, data);
    if (!fields.number) fields.number = await nextNumber(req.org, ...(await require("../utils/salesDoc").branchSeries("quote", prefix(org), fields.branch)));
    if (!fields.expiryDate) fields.expiryDate = undefined;
    const quote = await Quote.create({ ...fields, organization: req.org, status: data.status || "draft" });
    res.status(201).send(quote);
  })
);

router.get(
  "/:id",
  ah(async (req, res) => res.send(await findQuote(req)))
);

router.put(
  "/:id",
  ah(async (req, res) => {
    const quote = await findQuote(req);
    if (quote.status === "invoiced") throw new HttpError(400, "This quote has already been converted and can't be edited");
    const data = validate(schema, req.body);
    const { fields } = await prepareDoc(req, data);
    if (!fields.number) fields.number = quote.number;
    if (!fields.expiryDate) fields.expiryDate = undefined;
    const status = quote.status === "draft" ? data.status || "draft" : quote.status;
    quote.set({ ...fields, status });
    await quote.save();
    res.send(quote);
  })
);

// Mark as sent / accepted / declined.
router.post(
  "/:id/status",
  ah(async (req, res) => {
    const { status } = validate(Joi.object({ status: Joi.string().valid("sent", "accepted", "declined").required() }), req.body);
    const quote = await findQuote(req);
    if (quote.status === "invoiced") throw new HttpError(400, "This quote has already been converted");
    quote.status = status;
    await quote.save();
    res.send(quote);
  })
);

router.post(
  "/:id/convert-to-invoice",
  ah(async (req, res) => {
    const quote = await findQuote(req);
    if (quote.status === "invoiced") throw new HttpError(400, `Already converted to ${quote.convertedTo?.number || "another document"}`);
    const invoice = await createInvoiceFrom(req, quote, { quote: quote._id });
    quote.status = "invoiced";
    quote.convertedTo = { kind: "invoice", id: invoice._id, number: invoice.invoiceNumber };
    await quote.save();
    res.status(201).send(invoice);
  })
);

router.post(
  "/:id/convert-to-sales-order",
  ah(async (req, res) => {
    const quote = await findQuote(req);
    if (quote.status === "invoiced") throw new HttpError(400, `Already converted to ${quote.convertedTo?.number || "another document"}`);
    const org = await Organization.findById(req.org);
    const date = require("../utils/time").istToday();
    const so = await SalesOrder.create({
      ...copyContent(quote),
      number: await nextNumber(req.org, ...(await require("../utils/salesDoc").branchSeries("salesOrder", org.salesOrderPrefix || "SO-", quote.branch))),
      reference: quote.reference || quote.number,
      date,
      status: "draft",
      quote: quote._id,
      quoteNumber: quote.number,
    });
    quote.status = "invoiced";
    quote.convertedTo = { kind: "salesOrder", id: so._id, number: so.number };
    await quote.save();
    res.status(201).send(so);
  })
);

router.delete(
  "/:id",
  ah(async (req, res) => {
    const quote = await findQuote(req);
    const linked =
      (await Invoice.exists({ organization: req.org, quote: quote._id })) ||
      (await SalesOrder.exists({ organization: req.org, quote: quote._id }));
    if (linked) throw new HttpError(400, "Delete the sales order or invoice made from this quote first");
    await quote.deleteOne();
    res.send({ message: "Quote deleted" });
  })
);

module.exports = router;
