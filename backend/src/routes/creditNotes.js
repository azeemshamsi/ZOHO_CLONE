const router = require("express").Router();
const Joi = require("joi");
const CreditNote = require("../models/CreditNote");
const Invoice = require("../models/Invoice");
const Organization = require("../models/Organization");
const { ah, validate, HttpError, round2 } = require("../utils/http");
const { baseDocJoi, prepareDoc, peekNumber, settleInvoice, escapeRx, nextNumber } = require("../utils/salesDoc");

const schema = Joi.object({
  ...baseDocJoi,
  date: Joi.date().required().label("Credit note date"),
  number: Joi.string().trim().allow(""),
  reference: Joi.string().allow(""),
  invoice: Joi.string().allow(null, ""),
  reason: Joi.string().allow(""),
  status: Joi.string().valid("draft", "open"),
});

const prefix = (org) => org.creditNotePrefix || "CN-";

async function findCN(req) {
  const cn = await CreditNote.findOne({ _id: req.params.id, organization: req.org });
  if (!cn) throw new HttpError(404, "Credit note not found");
  return cn;
}

const used = (cn) => round2(cn.applications.reduce((s, a) => s + a.amount, 0) + cn.refunds.reduce((s, r) => s + r.amount, 0));

function refreshStatus(cn) {
  if (cn.status === "draft" || cn.status === "void") return cn;
  cn.balance = round2(Math.max(cn.total - used(cn), 0));
  cn.status = cn.balance > 0 ? "open" : "closed";
  return cn;
}

async function linkInvoice(req, fields) {
  if (!fields.invoice) {
    fields.invoice = undefined;
    fields.invoiceNumber = "";
    return;
  }
  const inv = await Invoice.findOne({ _id: fields.invoice, organization: req.org, customer: fields.customer });
  if (!inv) throw new HttpError(400, "The invoice you picked doesn't belong to this customer");
  fields.invoiceNumber = inv.invoiceNumber;
}

router.get(
  "/",
  ah(async (req, res) => {
    const filter = { organization: req.org };
    if (req.query.customer) filter.customer = req.query.customer;
    if (req.query.status && req.query.status !== "all") filter.status = req.query.status;
    if (req.query.q) {
      const rx = escapeRx(req.query.q);
      filter.$or = [{ number: rx }, { customerName: rx }, { reference: rx }, { invoiceNumber: rx }];
    }
    res.send(await CreditNote.find(filter, { lineItems: 0 }).sort({ date: -1, createdAt: -1 }));
  })
);

router.get(
  "/next-number",
  ah(async (req, res) => {
    const org = await Organization.findById(req.org);
    res.send({ number: await peekNumber(req.org, "creditNote", prefix(org)) });
  })
);

router.post(
  "/",
  ah(async (req, res) => {
    const data = validate(schema, req.body);
    const { org, fields } = await prepareDoc(req, data);
    await linkInvoice(req, fields);
    if (!fields.number) fields.number = await nextNumber(req.org, "creditNote", prefix(org));
    const cn = new CreditNote({ ...fields, organization: req.org, status: data.status || "draft", balance: fields.total });
    refreshStatus(cn);
    await cn.save();
    res.status(201).send(cn);
  })
);

router.get(
  "/:id",
  ah(async (req, res) => res.send(await findCN(req)))
);

router.put(
  "/:id",
  ah(async (req, res) => {
    const cn = await findCN(req);
    if (cn.status === "void") throw new HttpError(400, "A void credit note can't be edited");
    const data = validate(schema, req.body);
    const { fields } = await prepareDoc(req, data);
    await linkInvoice(req, fields);
    if (!fields.number) fields.number = cn.number;
    if (fields.total < used(cn)) throw new HttpError(400, "The new total is less than the credit already used");
    if (String(fields.customer) !== String(cn.customer) && used(cn) > 0) {
      throw new HttpError(400, "Remove the applied credits before changing the customer");
    }
    const status = cn.status === "draft" ? data.status || "draft" : cn.status;
    cn.set({ ...fields, status });
    refreshStatus(cn);
    await cn.save();
    res.send(cn);
  })
);

router.post(
  "/:id/open",
  ah(async (req, res) => {
    const cn = await findCN(req);
    if (cn.status === "draft") {
      cn.status = "open";
      refreshStatus(cn);
      await cn.save();
    }
    res.send(cn);
  })
);

// Apply credit to one or more of the customer's unpaid invoices.
router.post(
  "/:id/apply",
  ah(async (req, res) => {
    const { allocations } = validate(
      Joi.object({
        allocations: Joi.array()
          .items(Joi.object({ invoice: Joi.string().required(), amount: Joi.number().min(0).required() }))
          .min(1)
          .required(),
      }),
      req.body
    );
    const cn = await findCN(req);
    if (cn.status === "draft") throw new HttpError(400, "Open the credit note before applying it");
    if (cn.status !== "open") throw new HttpError(400, "This credit note has no credit left");
    const wanted = allocations.filter((a) => a.amount > 0);
    const totalWanted = round2(wanted.reduce((s, a) => s + a.amount, 0));
    if (totalWanted > cn.balance) throw new HttpError(400, "You're applying more than the credit available");

    const pairs = [];
    for (const a of wanted) {
      const inv = await Invoice.findOne({ _id: a.invoice, organization: req.org, customer: cn.customer });
      if (!inv || ["void", "draft"].includes(inv.status)) throw new HttpError(400, "One of the selected invoices can't take credits");
      if (round2(a.amount) > inv.balance) throw new HttpError(400, `Credit for ${inv.invoiceNumber} is more than its balance due`);
      pairs.push([inv, round2(a.amount)]);
    }
    for (const [inv, amount] of pairs) {
      inv.creditsApplied = round2(inv.creditsApplied + amount);
      settleInvoice(inv);
      await inv.save();
      cn.applications.push({ invoice: inv._id, invoiceNumber: inv.invoiceNumber, amount, date: new Date() });
    }
    refreshStatus(cn);
    await cn.save();
    res.send(cn);
  })
);

// Undo one application.
router.delete(
  "/:id/applications/:appId",
  ah(async (req, res) => {
    const cn = await findCN(req);
    const app = cn.applications.id(req.params.appId);
    if (!app) throw new HttpError(404, "Not found");
    const inv = await Invoice.findOne({ _id: app.invoice, organization: req.org });
    if (inv) {
      inv.creditsApplied = round2(Math.max(inv.creditsApplied - app.amount, 0));
      if (inv.status === "paid" || inv.status === "partially_paid") inv.status = "sent";
      settleInvoice(inv);
      await inv.save();
    }
    app.deleteOne();
    refreshStatus(cn);
    await cn.save();
    res.send(cn);
  })
);

router.post(
  "/:id/refund",
  ah(async (req, res) => {
    const data = validate(
      Joi.object({
        date: Joi.date().required().label("Refund date"),
        amount: Joi.number().greater(0).required().label("Amount"),
        mode: Joi.string().valid("cash", "bank_transfer", "upi", "cheque", "card", "other"),
        reference: Joi.string().allow(""),
        bankAccount: Joi.string().allow(""),
      }),
      req.body
    );
    const cn = await findCN(req);
    if (cn.status !== "open") throw new HttpError(400, "This credit note has no credit left to refund");
    if (round2(data.amount) > cn.balance) throw new HttpError(400, "The refund is more than the credit available");
    if (!(await require("../utils/ledger").isBankAccount(req.org, data.bankAccount))) throw new HttpError(400, "Pick a cash or bank account");
    cn.refunds.push({ ...data, amount: round2(data.amount) });
    refreshStatus(cn);
    await cn.save();
    res.send(cn);
  })
);

router.delete(
  "/:id/refunds/:refundId",
  ah(async (req, res) => {
    const cn = await findCN(req);
    const r = cn.refunds.id(req.params.refundId);
    if (!r) throw new HttpError(404, "Not found");
    r.deleteOne();
    refreshStatus(cn);
    await cn.save();
    res.send(cn);
  })
);

router.post(
  "/:id/void",
  ah(async (req, res) => {
    const cn = await findCN(req);
    if (used(cn) > 0) throw new HttpError(400, "Remove the applied credits and refunds before voiding");
    cn.status = "void";
    cn.balance = 0;
    await cn.save();
    res.send(cn);
  })
);

router.delete(
  "/:id",
  ah(async (req, res) => {
    const cn = await findCN(req);
    if (used(cn) > 0) throw new HttpError(400, "Remove the applied credits and refunds before deleting");
    await cn.deleteOne();
    res.send({ message: "Credit note deleted" });
  })
);

module.exports = router;
