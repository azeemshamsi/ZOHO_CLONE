const router = require("express").Router();
const Joi = require("joi");
const PurchaseOrder = require("../models/PurchaseOrder");
const Organization = require("../models/Organization");
const { ah, validate, HttpError } = require("../utils/http");
const { baseDocJoi, prepareDoc, peekNumber, escapeRx, nextNumber } = require("../utils/salesDoc");

const { customer, ...rest } = baseDocJoi;
const schema = Joi.object({
  ...rest,
  vendor: Joi.string().required().label("Vendor"),
  date: Joi.date().required().label("Purchase order date"),
  number: Joi.string().trim().allow(""),
  reference: Joi.string().allow(""),
  deliveryDate: Joi.date().allow(null, ""),
  status: Joi.string().valid("draft", "issued"),
});

const prefix = (org) => org.purchaseOrderPrefix || "PO-";

async function findPO(req) {
  const po = await PurchaseOrder.findOne({ _id: req.params.id, organization: req.org });
  if (!po) throw new HttpError(404, "Purchase order not found");
  return po;
}

router.get(
  "/",
  ah(async (req, res) => {
    const filter = { organization: req.org };
    if (req.query.vendor) filter.vendor = req.query.vendor;
    if (req.query.status && req.query.status !== "all") filter.status = req.query.status;
    if (req.query.q) {
      const rx = escapeRx(req.query.q);
      filter.$or = [{ number: rx }, { vendorName: rx }, { reference: rx }];
    }
    res.send(await PurchaseOrder.find(filter, { lineItems: 0 }).sort({ date: -1, createdAt: -1 }));
  })
);

router.get(
  "/next-number",
  ah(async (req, res) => {
    const org = await Organization.findById(req.org);
    res.send({ number: await peekNumber(req.org, "purchaseOrder", prefix(org)) });
  })
);

router.post(
  "/",
  ah(async (req, res) => {
    const data = validate(schema, req.body);
    const { org, fields } = await prepareDoc(req, data, "vendor");
    if (!fields.number) fields.number = await nextNumber(req.org, "purchaseOrder", prefix(org));
    if (!fields.deliveryDate) fields.deliveryDate = undefined;
    res.status(201).send(await PurchaseOrder.create({ ...fields, organization: req.org, status: data.status || "draft" }));
  })
);

router.get(
  "/:id",
  ah(async (req, res) => res.send(await findPO(req)))
);

router.put(
  "/:id",
  ah(async (req, res) => {
    const po = await findPO(req);
    if (["billed", "cancelled"].includes(po.status)) throw new HttpError(400, `A ${po.status} purchase order can't be edited`);
    const data = validate(schema, req.body);
    const { fields } = await prepareDoc(req, data, "vendor");
    if (!fields.number) fields.number = po.number;
    if (!fields.deliveryDate) fields.deliveryDate = undefined;
    po.set({ ...fields, status: po.status === "draft" ? data.status || "draft" : po.status });
    await po.save();
    res.send(po);
  })
);

router.post(
  "/:id/status",
  ah(async (req, res) => {
    const { status } = validate(Joi.object({ status: Joi.string().valid("issued", "cancelled", "draft").required() }), req.body);
    const po = await findPO(req);
    if (po.status === "billed") throw new HttpError(400, "This purchase order has already been billed");
    po.status = status;
    await po.save();
    res.send(po);
  })
);

router.delete(
  "/:id",
  ah(async (req, res) => {
    const po = await findPO(req);
    if (po.bill) throw new HttpError(400, `Delete bill ${po.billNumber} first`);
    await po.deleteOne();
    res.send({ message: "Purchase order deleted" });
  })
);

module.exports = router;
