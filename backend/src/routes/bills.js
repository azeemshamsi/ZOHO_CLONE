const router = require("express").Router();
const Joi = require("joi");
const Bill = require("../models/Bill");
const VendorPayment = require("../models/VendorPayment");
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
  customerNotes: Joi.string().allow(""),
  terms: Joi.string().allow(""),
  status: Joi.string().valid("draft", "open"),
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

router.post(
  "/",
  ah(async (req, res) => {
    const data = validate(schema, req.body);
    const { fields } = await build(req, data);
    const bill = new Bill({ ...fields, organization: req.org, status: data.status || "open" });
    settleBill(bill);
    await bill.save();
    res.status(201).send(bill);
  })
);

router.get(
  "/:id",
  ah(async (req, res) => {
    const bill = await findBill(req);
    const payments = await VendorPayment.find({ organization: req.org, "allocations.bill": bill._id }).lean();
    res.send({
      ...bill.toJSON(),
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
    if (fields.total < bill.amountPaid) throw new HttpError(400, "The new total is less than the amount already paid on this bill");
    const status = bill.status === "draft" ? data.status || "draft" : bill.status;
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
    await bill.deleteOne();
    res.send({ message: "Bill deleted" });
  })
);

module.exports = router;
