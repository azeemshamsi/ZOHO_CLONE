const router = require("express").Router();
const Joi = require("joi");
const Bill = require("../models/Bill");
const VendorPayment = require("../models/VendorPayment");
const PurchaseOrder = require("../models/PurchaseOrder");
const VendorCredit = require("../models/VendorCredit");
const { ah, validate, HttpError } = require("../utils/http");
const { lineItemJoi, prepareDoc, settleBill, escapeRx } = require("../utils/salesDoc");

const schema = Joi.object({
  vendor: Joi.string().required().label("Vendor"),
  billNumber: Joi.string().trim().required().label("Bill#"),
  orderNumber: Joi.string().allow(""),
  date: Joi.date().required().label("Bill date"),
  paymentTerms: Joi.number().min(0).max(365),
  dueDate: Joi.date().required().label("Due date"),
  placeOfSupply: Joi.string().allow(""),
  lineItems: Joi.array().items(lineItemJoi).min(1).required().label("Items"),
  shippingCharge: Joi.number().min(0),
  adjustment: Joi.number(),
  adjustmentAccount: Joi.string().allow(""),
  ledger: Joi.string().allow(""),
  customerNotes: Joi.string().allow(""),
  terms: Joi.string().allow(""),
  status: Joi.string().valid("draft", "open"),
  purchaseOrder: Joi.string().allow(null, ""),
  branch: Joi.string().allow(null, ""),
  warehouse: Joi.string().allow(null, ""),
  exchangeRate: Joi.number().greater(0),
});

async function build(req, data) {
  const out = await prepareDoc(req, data, "vendor");
  if (new Date(data.dueDate) < new Date(new Date(data.date).toDateString())) {
    throw new HttpError(400, "Due date can't be before the bill date");
  }
  const dup = await Bill.findOne({ organization: req.org, vendor: data.vendor, billNumber: data.billNumber });
  if (dup && String(dup._id) !== String(req.params.id || "")) {
    throw new HttpError(409, `You've already recorded bill ${data.billNumber} from this vendor`);
  }
  return out;
}

async function findBill(req) {
  const bill = await Bill.findOne({ _id: req.params.id, organization: req.org });
  if (!bill) throw new HttpError(404, "Bill not found");
  return bill;
}

router.get(
  "/",
  ah(async (req, res) => {
    const filter = { organization: req.org };
    if (req.query.vendor) filter.vendor = req.query.vendor;
    if (req.query.open === "1") filter.status = { $in: ["open", "partially_paid"] };
    if (req.query.q) {
      const rx = escapeRx(req.query.q);
      filter.$or = [{ billNumber: rx }, { vendorName: rx }, { orderNumber: rx }];
    }
    let bills = await Bill.find(filter, { lineItems: 0 }).sort({ date: -1, createdAt: -1 });
    const s = req.query.status;
    if (s && s !== "all") {
      bills = bills.filter((b) => (s === "unpaid" ? b.balance > 0 && !["void", "draft"].includes(b.status) : b.displayStatus === s));
    }
    res.send(bills);
  })
);

router.get("/next-number", (req, res) => res.send({ number: "" }));

// TDS deducted on bills but posted to Rounding & Adjustments (typed in the plain Adjustment box, or imported
// when Tally's TDS ledger wasn't matched): list them, and move them to a TDS ledger. Only the ledger changes —
// the bill's amounts and what's owed to the vendor stay the same. A few paise of round-off beside the TDS stay
// in Rounding & Adjustments.
const TDS_RATES = [0.1, 1, 2, 5, 10, 20];
const tdsSplit = (b) => {
  const taxable = Math.round((b.subTotal || (b.lineItems || []).reduce((t, l) => t + (l.amount || 0), 0)) * 100) / 100;
  const ded = -(b.adjustment || 0);
  let best = null;
  for (const r of TDS_RATES) {
    const tds = Math.round((taxable * r) / 100 * 100) / 100;
    const off = Math.round((ded - tds) * 100) / 100;
    if (Math.abs(off) < 1 && (!best || Math.abs(off) < Math.abs(best.off))) best = { rate: r, tds, off };
  }
  return { taxable, rate: best?.rate ?? null, roundOff: best ? -best.off : 0 };
};
const isTdsAccount = (a) => a && /tds/i.test(a.name) && ["Other Current Liability", "Other Liability", "Current Liability", "Other Current Asset"].includes(a.group);
router.get(
  "/tds-in-rounding",
  ah(async (req, res) => {
    const Account = require("../models/Account");
    const [bills, accounts] = await Promise.all([Bill.find({ organization: req.org }, { billNumber: 1, vendor: 1, vendorName: 1, date: 1, adjustment: 1, adjustmentAccount: 1, adjustmentRoundOff: 1, subTotal: 1, status: 1, "lineItems.amount": 1 }).lean(), Account.find({ organization: req.org }).lean()]);
    const tdsCodes = new Set(accounts.filter(isTdsAccount).map((a) => String(a._id)));
    const live = bills.filter((b) => !["draft", "void"].includes(b.status));
    // A vendor's usual TDS ledger: the one on their other bills.
    const usual = new Map();
    for (const b of live) if (tdsCodes.has(b.adjustmentAccount)) usual.set(String(b.vendor), b.adjustmentAccount);
    const rows = live
      .filter((b) => !b.adjustmentAccount && (b.adjustment || 0) <= -1)
      .map((b) => ({ _id: b._id, billNumber: b.billNumber, vendorName: b.vendorName, date: b.date, adjustment: b.adjustment, ...tdsSplit(b), ledger: usual.get(String(b.vendor)) || "" }))
      .sort((a, b) => new Date(a.date) - new Date(b.date));
    res.send({ rows, ledgers: accounts.filter(isTdsAccount).map((a) => ({ code: String(a._id), name: a.name })) });
  })
);
router.post(
  "/tds-in-rounding/move",
  ah(async (req, res) => {
    const { items } = validate(Joi.object({ items: Joi.array().items(Joi.object({ id: Joi.string().hex().length(24).required(), account: Joi.string().hex().length(24).required() })).min(1).max(500).required() }), req.body);
    const Account = require("../models/Account");
    const accounts = new Map((await Account.find({ organization: req.org }).lean()).map((a) => [String(a._id), a]));
    let moved = 0;
    for (const it of items) {
      if (!isTdsAccount(accounts.get(it.account))) throw new HttpError(400, "Choose a TDS ledger");
      const b = await Bill.findOne({ _id: it.id, organization: req.org }).lean();
      if (!b || b.adjustmentAccount || (b.adjustment || 0) > -1) continue;
      const { roundOff } = tdsSplit(b);
      await Bill.updateOne({ _id: b._id, organization: req.org }, { adjustmentAccount: it.account, adjustmentRoundOff: roundOff });
      moved++;
    }
    await require("../utils/audit").log(req, "tds_moved_from_rounding", { target: `${moved} bills`, meta: { items: items.length } });
    res.send({ moved });
  })
);

router.post(
  "/",
  ah(async (req, res) => {
    const data = validate(schema, req.body);
    const { fields } = await build(req, data);
    let po = null;
    if (data.purchaseOrder) {
      po = await PurchaseOrder.findOne({ _id: data.purchaseOrder, organization: req.org, vendor: data.vendor });
      if (!po) throw new HttpError(400, "That purchase order doesn't belong to this vendor");
      if (po.bill) throw new HttpError(400, `Purchase order ${po.number} is already billed`);
    }
    const bill = new Bill({ ...fields, purchaseOrder: po ? po._id : undefined, organization: req.org, status: data.status || "open" });
    settleBill(bill);
    await bill.save();
    if (po) {
      po.status = "billed";
      po.bill = bill._id;
      po.billNumber = bill.billNumber;
      await po.save();
    }
    res.status(201).send(bill);
  })
);

router.get(
  "/:id",
  ah(async (req, res) => {
    const bill = await findBill(req);
    const [payments, credits] = await Promise.all([
      VendorPayment.find({ organization: req.org, "allocations.bill": bill._id }).lean(),
      VendorCredit.find({ organization: req.org, "applications.bill": bill._id }).lean(),
    ]);
    res.send({
      ...bill.toJSON(),
      credits: credits.map((c) => ({
        _id: c._id,
        number: c.number,
        date: c.date,
        amount: c.applications.filter((a) => String(a.bill) === String(bill._id)).reduce((s, a) => s + a.amount, 0),
      })),
      payments: payments.map((p) => ({
        _id: p._id,
        paymentNumber: p.paymentNumber,
        date: p.date,
        mode: p.mode,
        reference: p.reference,
        amount: p.allocations.filter((a) => String(a.bill) === String(bill._id)).reduce((s, a) => s + a.amount, 0),
      })),
    });
  })
);

router.put(
  "/:id",
  ah(async (req, res) => {
    const bill = await findBill(req);
    if (bill.status === "void") throw new HttpError(400, "A void bill can't be edited");
    const data = validate(schema, req.body);
    const { fields } = await build(req, data);
    if (fields.total < bill.amountPaid + bill.creditsApplied) throw new HttpError(400, "The new total is less than the payments and credits already applied to this bill");
    const status = bill.status === "draft" ? data.status || "draft" : bill.status;
    delete fields.purchaseOrder;
    bill.set({ ...fields, status });
    settleBill(bill);
    await bill.save();
    res.send(bill);
  })
);

router.post(
  "/:id/open",
  ah(async (req, res) => {
    const bill = await findBill(req);
    if (bill.status === "draft") {
      bill.status = "open";
      settleBill(bill);
      await bill.save();
    }
    res.send(bill);
  })
);

router.post(
  "/:id/void",
  ah(async (req, res) => {
    const bill = await findBill(req);
    if (bill.amountPaid > 0) throw new HttpError(400, "Delete the payments on this bill before voiding it");
    if (bill.creditsApplied > 0) throw new HttpError(400, "Remove the vendor credits applied to this bill before voiding it");
    bill.status = "void";
    bill.balance = 0;
    await bill.save();
    res.send(bill);
  })
);

router.delete(
  "/:id",
  ah(async (req, res) => {
    const bill = await findBill(req);
    if (bill.amountPaid > 0) throw new HttpError(400, "Delete the payments on this bill before deleting it");
    if (bill.creditsApplied > 0) throw new HttpError(400, "Remove the vendor credits applied to this bill before deleting it");
    await PurchaseOrder.updateMany(
      { organization: req.org, bill: bill._id },
      { $set: { status: "issued", billNumber: "" }, $unset: { bill: 1 } }
    );
    await bill.deleteOne();
    res.send({ message: "Bill deleted" });
  })
);

// Shared with recurring bills (no purchase order link).
async function createBill(req, body) {
  const data = validate(schema, body);
  const { fields } = await build(req, data);
  const bill = new Bill({ ...fields, organization: req.org, status: data.status || "open" });
  settleBill(bill);
  await bill.save();
  return bill;
}

module.exports = router;
module.exports.schema = schema;
module.exports.createBill = createBill;
