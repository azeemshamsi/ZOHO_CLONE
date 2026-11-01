const router = require("express").Router();
const Joi = require("joi");
const VendorCredit = require("../models/VendorCredit");
const Bill = require("../models/Bill");
const Organization = require("../models/Organization");
const { ah, validate, HttpError, round2 } = require("../utils/http");
const { baseDocJoi, prepareDoc, peekNumber, settleBill, escapeRx, nextNumber } = require("../utils/salesDoc");

const { customer: _c, ...rest } = baseDocJoi;
const schema = Joi.object({
  ...rest,
  vendor: Joi.string().required().label("Vendor"),
  date: Joi.date().required().label("Vendor credit date"),
  number: Joi.string().trim().allow(""),
  reference: Joi.string().allow(""),
  bill: Joi.string().allow(null, ""),
  reason: Joi.string().allow(""),
  status: Joi.string().valid("draft", "open"),
});

const prefix = (org) => org.vendorCreditPrefix || "DN-";

async function findCN(req) {
  const cn = await VendorCredit.findOne({ _id: req.params.id, organization: req.org });
  if (!cn) throw new HttpError(404, "Vendor credit not found");
  return cn;
}

const used = (cn) => round2(cn.applications.reduce((s, a) => s + a.amount, 0) + cn.refunds.reduce((s, r) => s + r.amount, 0));

function refreshStatus(cn) {
  if (cn.status === "draft" || cn.status === "void") return cn;
  cn.balance = round2(Math.max(cn.total - used(cn), 0));
  cn.status = cn.balance > 0 ? "open" : "closed";
  return cn;
}

async function linkBill(req, fields) {
  if (!fields.bill) {
    fields.bill = undefined;
    fields.billNumber = "";
    return;
  }
  const b = await Bill.findOne({ _id: fields.bill, organization: req.org, vendor: fields.vendor });
  if (!b) throw new HttpError(400, "The bill you picked doesn't belong to this vendor");
  fields.billNumber = b.billNumber;
}

router.get(
  "/",
  ah(async (req, res) => {
    const filter = { organization: req.org };
    if (req.query.vendor) filter.vendor = req.query.vendor;
    if (req.query.status && req.query.status !== "all") filter.status = req.query.status;
    if (req.query.q) {
      const rx = escapeRx(req.query.q);
      filter.$or = [{ number: rx }, { vendorName: rx }, { reference: rx }, { billNumber: rx }];
    }
    res.send(await VendorCredit.find(filter, { lineItems: 0 }).sort({ date: -1, createdAt: -1 }));
  })
);

router.get(
  "/next-number",
  ah(async (req, res) => {
    const org = await Organization.findById(req.org);
    res.send({ number: await peekNumber(req.org, ...(await require("../utils/salesDoc").branchSeries("vendorCredit", prefix(org), req.query.branch))) });
  })
);

router.post(
  "/",
  ah(async (req, res) => {
    const data = validate(schema, req.body);
    const { org, fields } = await prepareDoc(req, data, "vendor");
    await linkBill(req, fields);
    if (!fields.number) fields.number = await nextNumber(req.org, ...(await require("../utils/salesDoc").branchSeries("vendorCredit", prefix(org), fields.branch)));
    const cn = new VendorCredit({ ...fields, organization: req.org, status: data.status || "draft", balance: fields.total });
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
    if (cn.status === "void") throw new HttpError(400, "A void vendor credit can't be edited");
    const data = validate(schema, req.body);
    const { fields } = await prepareDoc(req, data, "vendor");
    await linkBill(req, fields);
    if (!fields.number) fields.number = cn.number;
    if (fields.total < used(cn)) throw new HttpError(400, "The new total is less than the credit already used");
    if (String(fields.vendor) !== String(cn.vendor) && used(cn) > 0) {
      throw new HttpError(400, "Remove the applied credits before changing the vendor");
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

// Apply credit to one or more of the vendor's unpaid bills.
router.post(
  "/:id/apply",
  ah(async (req, res) => {
    const { allocations } = validate(
      Joi.object({
        allocations: Joi.array()
          .items(Joi.object({ bill: Joi.string().required(), amount: Joi.number().min(0).required() }))
          .min(1)
          .required(),
      }),
      req.body
    );
    const cn = await findCN(req);
    if (cn.status === "draft") throw new HttpError(400, "Open the vendor credit before applying it");
    if (cn.status !== "open") throw new HttpError(400, "This vendor credit has no credit left");
    const wanted = allocations.filter((a) => a.amount > 0);
    const totalWanted = round2(wanted.reduce((s, a) => s + a.amount, 0));
    if (totalWanted > cn.balance) throw new HttpError(400, "You're applying more than the credit available");

    const pairs = [];
    for (const a of wanted) {
      const inv = await Bill.findOne({ _id: a.bill, organization: req.org, vendor: cn.vendor });
      if (!inv || ["void", "draft"].includes(inv.status)) throw new HttpError(400, "One of the selected bills can't take credits");
      if (round2(a.amount) > inv.balance) throw new HttpError(400, `Credit for bill ${inv.billNumber} is more than its balance due`);
      pairs.push([inv, round2(a.amount)]);
    }
    for (const [inv, amount] of pairs) {
      inv.creditsApplied = round2(inv.creditsApplied + amount);
      settleBill(inv);
      await inv.save();
      cn.applications.push({ bill: inv._id, billNumber: inv.billNumber, amount, date: new Date() });
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
    const inv = await Bill.findOne({ _id: app.bill, organization: req.org });
    if (inv) {
      inv.creditsApplied = round2(Math.max(inv.creditsApplied - app.amount, 0));
      if (inv.status === "paid" || inv.status === "partially_paid") inv.status = "open";
      settleBill(inv);
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
    if (cn.status !== "open") throw new HttpError(400, "This vendor credit has no credit left to refund");
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
    res.send({ message: "Vendor credit deleted" });
  })
);

module.exports = router;
