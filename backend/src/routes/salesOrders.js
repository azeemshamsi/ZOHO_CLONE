const router = require("express").Router();
const Joi = require("joi");
const SalesOrder = require("../models/SalesOrder");
const Quote = require("../models/Quote");
const Organization = require("../models/Organization");
const { ah, validate, HttpError } = require("../utils/http");
const { baseDocJoi, prepareDoc, peekNumber, createInvoiceFrom, escapeRx, nextNumber } = require("../utils/salesDoc");

const schema = Joi.object({
  ...baseDocJoi,
  date: Joi.date().required().label("Sales order date"),
  number: Joi.string().trim().allow(""),
  reference: Joi.string().allow(""),
  shipmentDate: Joi.date().allow(null, ""),
  status: Joi.string().valid("draft", "confirmed"),
});

const prefix = (org) => org.salesOrderPrefix || "SO-";

async function findSO(req) {
  const so = await SalesOrder.findOne({ _id: req.params.id, organization: req.org });
  if (!so) throw new HttpError(404, "Sales order not found");
  return so;
}

router.get(
  "/",
  ah(async (req, res) => {
    const filter = { organization: req.org };
    if (req.query.customer) filter.customer = req.query.customer;
    if (req.query.status && req.query.status !== "all") filter.status = req.query.status;
    if (req.query.q) {
      const rx = escapeRx(req.query.q);
      filter.$or = [{ number: rx }, { customerName: rx }, { reference: rx }];
    }
    res.send(await SalesOrder.find(filter, { lineItems: 0 }).sort({ date: -1, createdAt: -1 }));
  })
);

router.get(
  "/next-number",
  ah(async (req, res) => {
    const org = await Organization.findById(req.org);
    res.send({ number: await peekNumber(req.org, "salesOrder", prefix(org)) });
  })
);

router.post(
  "/",
  ah(async (req, res) => {
    const data = validate(schema, req.body);
    const { org, fields } = await prepareDoc(req, data);
    if (!fields.number) fields.number = await nextNumber(req.org, "salesOrder", prefix(org));
    if (!fields.shipmentDate) fields.shipmentDate = undefined;
    const so = await SalesOrder.create({ ...fields, organization: req.org, status: data.status || "draft" });
    res.status(201).send(so);
  })
);

router.get(
  "/:id",
  ah(async (req, res) => res.send(await findSO(req)))
);

router.put(
  "/:id",
  ah(async (req, res) => {
    const so = await findSO(req);
    if (["invoiced", "cancelled"].includes(so.status)) {
      throw new HttpError(400, `A ${so.status} sales order can't be edited`);
    }
    const data = validate(schema, req.body);
    const { fields } = await prepareDoc(req, data);
    if (!fields.number) fields.number = so.number;
    if (!fields.shipmentDate) fields.shipmentDate = undefined;
    const status = so.status === "draft" ? data.status || "draft" : so.status;
    so.set({ ...fields, status });
    await so.save();
    res.send(so);
  })
);

router.post(
  "/:id/status",
  ah(async (req, res) => {
    const { status } = validate(Joi.object({ status: Joi.string().valid("confirmed", "cancelled", "draft").required() }), req.body);
    const so = await findSO(req);
    if (so.status === "invoiced") throw new HttpError(400, "This sales order has already been invoiced");
    so.status = status;
    await so.save();
    res.send(so);
  })
);

router.post(
  "/:id/convert-to-invoice",
  ah(async (req, res) => {
    const so = await findSO(req);
    if (so.status === "invoiced") throw new HttpError(400, `Already invoiced as ${so.invoiceNumber}`);
    if (so.status === "cancelled") throw new HttpError(400, "A cancelled sales order can't be invoiced");
    const invoice = await createInvoiceFrom(req, so, { salesOrder: so._id, quote: so.quote }, so.number);
    so.status = "invoiced";
    so.invoice = invoice._id;
    so.invoiceNumber = invoice.invoiceNumber;
    await so.save();
    res.status(201).send(invoice);
  })
);

router.delete(
  "/:id",
  ah(async (req, res) => {
    const so = await findSO(req);
    if (so.invoice) throw new HttpError(400, `Delete invoice ${so.invoiceNumber} first`);
    if (so.quote) {
      await Quote.updateOne(
        { _id: so.quote, organization: req.org, "convertedTo.id": so._id },
        { $set: { status: "accepted" }, $unset: { convertedTo: 1 } }
      );
    }
    await so.deleteOne();
    res.send({ message: "Sales order deleted" });
  })
);

module.exports = router;
