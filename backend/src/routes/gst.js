const router = require("express").Router();
const Joi = require("joi");
const Invoice = require("../models/Invoice");
const CreditNote = require("../models/CreditNote");
const Customer = require("../models/Customer");
const Organization = require("../models/Organization");
const { ah, validate, HttpError } = require("../utils/http");
const { buildEInvoice, buildEwayBill, needsEInvoice, isService } = require("../utils/einvoice");

const MODEL = { invoice: Invoice, creditNote: CreditNote };
const numberOf = (kind, d) => (kind === "invoice" ? d.invoiceNumber : d.number);
const live = { status: { $nin: ["draft", "void"] } };

async function findDoc(req, kind, id) {
  const M = MODEL[kind];
  if (!M) throw new HttpError(404, "Unknown document type");
  const d = await M.findOne({ _id: id, organization: req.org });
  if (!d) throw new HttpError(404, "Document not found");
  return d;
}

router.put(
  "/settings",
  ah(async (req, res) => {
    if (require("../utils/roles").permsOf(req.user.role).settings !== "full") throw new HttpError(403, "Only admins can change GST settings");
    const d = validate(
      Joi.object({
        einvoicing: Joi.object({ enabled: Joi.boolean().required(), fromDate: Joi.date().allow(null, "") }),
        ewayBills: Joi.object({ enabled: Joi.boolean().required(), threshold: Joi.number().min(0).default(50000) }),
      }),
      req.body
    );
    const set = {};
    if (d.einvoicing) set.einvoicing = { enabled: d.einvoicing.enabled, fromDate: d.einvoicing.fromDate || null };
    if (d.ewayBills) set.ewayBills = d.ewayBills;
    res.send(await Organization.findByIdAndUpdate(req.org, set, { new: true }));
  })
);

/* ----------------------------- E-invoices ----------------------------- */
// Invoices and credit notes that need (or have) an e-invoice, with any problems that would stop upload.
router.get(
  "/einvoices",
  ah(async (req, res) => {
    const org = await Organization.findById(req.org);
    const status = req.query.status || "pending";
    const from = org.einvoicing?.fromDate;
    const q = { organization: req.org, ...live, ...(from && status === "pending" ? { date: { $gte: from } } : {}) };
    q["einvoice.status"] = status === "pending" ? { $nin: ["generated", "cancelled"] } : status;
    const customers = await Customer.find({ organization: req.org }, { gstTreatment: 1 }).lean();
    const eligible = new Set(customers.filter(needsEInvoice).map((c) => String(c._id)));
    const out = [];
    for (const [kind, M] of Object.entries(MODEL)) {
      const docs = await M.find(q).sort({ date: -1 }).lean();
      for (const d of docs) {
        if (!eligible.has(String(d.customer))) continue;
        const row = { kind, id: d._id, number: numberOf(kind, d), date: d.date, customerName: d.customerName, total: d.total, currency: d.currency, einvoice: d.einvoice || {} };
        if (status === "pending") row.errors = (await buildEInvoice(org, d, kind)).errors;
        out.push(row);
      }
    }
    out.sort((a, b) => new Date(b.date) - new Date(a.date));
    res.send(out);
  })
);

router.get(
  "/einvoice/:kind/:id/json",
  ah(async (req, res) => {
    const org = await Organization.findById(req.org);
    const d = await findDoc(req, req.params.kind, req.params.id);
    res.send(await buildEInvoice(org, d.toObject(), req.params.kind));
  })
);

// One file for the IRP bulk upload. Documents with problems are left out and listed.
router.post(
  "/einvoice/bulk-json",
  ah(async (req, res) => {
    const { docs } = validate(Joi.object({ docs: Joi.array().items(Joi.object({ kind: Joi.string().valid("invoice", "creditNote").required(), id: Joi.string().required() })).min(1).required() }), req.body);
    const org = await Organization.findById(req.org);
    const json = [];
    const skipped = [];
    for (const x of docs) {
      const d = await findDoc(req, x.kind, x.id);
      const r = await buildEInvoice(org, d.toObject(), x.kind);
      if (r.errors.length) skipped.push({ number: numberOf(x.kind, d), errors: r.errors });
      else json.push(r.json);
    }
    res.send({ json, skipped });
  })
);

const irnSchema = Joi.object({
  irn: Joi.string().trim().lowercase().pattern(/^[0-9a-f]{64}$/).required().label("IRN").messages({ "string.pattern.base": "IRN is the 64-character code from the e-invoice portal" }),
  ackNo: Joi.string().trim().pattern(/^[0-9]{10,20}$/).required().label("Ack No").messages({ "string.pattern.base": "Ack No is a number (usually 15 digits)" }),
  ackDate: Joi.date().required().label("Ack Date"),
  signedQr: Joi.string().trim().allow("").label("Signed QR code"),
});

router.post(
  "/einvoice/:kind/:id/irn",
  ah(async (req, res) => {
    const data = validate(irnSchema, req.body);
    const d = await findDoc(req, req.params.kind, req.params.id);
    if (d.einvoice?.status === "generated") throw new HttpError(400, "This document already has an IRN");
    const M = MODEL[req.params.kind];
    if (await M.exists({ organization: req.org, "einvoice.irn": data.irn, _id: { $ne: d._id } })) throw new HttpError(409, "That IRN is already recorded on another document");
    d.einvoice = { status: "generated", irn: data.irn, ackNo: data.ackNo, ackDate: data.ackDate, signedQr: data.signedQr };
    if (req.params.kind === "invoice" && d.status === "draft") d.status = "sent";
    await d.save();
    res.send(d);
  })
);

router.post(
  "/einvoice/:kind/:id/cancel",
  ah(async (req, res) => {
    const { reason } = validate(Joi.object({ reason: Joi.string().valid("Duplicate", "Data entry mistake", "Order cancelled", "Others").required(), remarks: Joi.string().allow("") }), req.body);
    const d = await findDoc(req, req.params.kind, req.params.id);
    if (d.einvoice?.status !== "generated") throw new HttpError(400, "There's no active e-invoice to cancel");
    d.einvoice.status = "cancelled";
    d.einvoice.cancelReason = reason;
    d.einvoice.cancelledAt = new Date();
    await d.save();
    const hrs = d.einvoice.ackDate ? (Date.now() - new Date(d.einvoice.ackDate).getTime()) / 3600000 : 0;
    res.send({ doc: d, warning: hrs > 24 ? "The IRP only allows cancelling within 24 hours of generation. If it's later than that, issue a credit note instead." : "" });
  })
);

// Undo a wrongly entered IRN (only clears it in OrdexaGo).
router.delete(
  "/einvoice/:kind/:id/irn",
  ah(async (req, res) => {
    const d = await findDoc(req, req.params.kind, req.params.id);
    d.einvoice = { status: "none" };
    await d.save();
    res.send(d);
  })
);

/* ----------------------------- E-way bills ----------------------------- */
router.get(
  "/eway-bills",
  ah(async (req, res) => {
    const org = await Organization.findById(req.org);
    const threshold = org.ewayBills?.threshold ?? 50000;
    const status = req.query.status || "pending";
    const q = { organization: req.org, ...live, "eway.status": status === "pending" ? { $nin: ["generated", "cancelled"] } : status };
    const docs = await Invoice.find(q).sort({ date: -1 }).limit(500).lean();
    const out = [];
    for (const d of docs) {
      const goodsValue = (d.lineItems || []).filter((l) => !isService(l.hsnSac)).reduce((s, l) => s + l.amount + l.cgst + l.sgst + l.igst, 0) * (d.exchangeRate || 1);
      if (!goodsValue) continue;
      const value = d.total * (d.exchangeRate || 1);
      if (status === "pending" && value < threshold && !(d.eway && d.eway.distance)) continue;
      const row = { id: d._id, number: d.invoiceNumber, date: d.date, customerName: d.customerName, value: Math.round(value * 100) / 100, eway: d.eway || {}, required: value >= threshold };
      if (status === "pending") row.errors = (await buildEwayBill(org, d)).errors;
      out.push(row);
    }
    res.send(out);
  })
);

const transportSchema = Joi.object({
  transMode: Joi.string().valid("1", "2", "3", "4").default("1"),
  distance: Joi.number().min(0).max(4000).required().label("Distance"),
  transporterName: Joi.string().allow(""),
  transporterId: Joi.string().allow("").uppercase(),
  vehicleNo: Joi.string().allow("").uppercase(),
  vehicleType: Joi.string().valid("R", "O").default("R"),
  transDocNo: Joi.string().allow(""),
  transDocDate: Joi.date().allow(null, ""),
  shipTo: Joi.object({ street: Joi.string().allow(""), city: Joi.string().allow(""), state: Joi.string().allow(""), pincode: Joi.string().allow("") }).default({}),
});

router.put(
  "/eway/:id/transport",
  ah(async (req, res) => {
    const data = validate(transportSchema, req.body);
    if (!data.transDocDate) data.transDocDate = null;
    const d = await findDoc(req, "invoice", req.params.id);
    if (d.eway?.status === "generated") throw new HttpError(400, "The e-way bill is already generated. Update Part B on the e-way bill portal.");
    d.eway = { ...(d.eway?.toObject ? d.eway.toObject() : d.eway || {}), ...data, status: d.eway?.status || "none" };
    await d.save();
    const org = await Organization.findById(req.org);
    res.send({ eway: d.eway, errors: (await buildEwayBill(org, d.toObject())).errors });
  })
);

router.post(
  "/eway/bulk-json",
  ah(async (req, res) => {
    const { ids } = validate(Joi.object({ ids: Joi.array().items(Joi.string()).min(1).required() }), req.body);
    const org = await Organization.findById(req.org);
    const billLists = [];
    const skipped = [];
    for (const id of ids) {
      const d = await findDoc(req, "invoice", id);
      const r = await buildEwayBill(org, d.toObject());
      if (r.errors.length) skipped.push({ number: d.invoiceNumber, errors: r.errors });
      else billLists.push(r.json);
    }
    res.send({ json: { version: "1.0.0421", billLists }, skipped });
  })
);

router.post(
  "/eway/:id/ewb",
  ah(async (req, res) => {
    const data = validate(
      Joi.object({
        ewbNo: Joi.string().trim().pattern(/^[0-9]{12}$/).required().label("E-way bill number").messages({ "string.pattern.base": "The e-way bill number has 12 digits" }),
        ewbDate: Joi.date().required().label("Generated on"),
        validUpto: Joi.date().allow(null, ""),
      }),
      req.body
    );
    const d = await findDoc(req, "invoice", req.params.id);
    d.eway = { ...(d.eway?.toObject ? d.eway.toObject() : d.eway || {}), status: "generated", ewbNo: data.ewbNo, ewbDate: data.ewbDate, validUpto: data.validUpto || null };
    await d.save();
    res.send(d);
  })
);

router.post(
  "/eway/:id/cancel",
  ah(async (req, res) => {
    const d = await findDoc(req, "invoice", req.params.id);
    if (d.eway?.status !== "generated") throw new HttpError(400, "No e-way bill to cancel");
    d.eway.status = "cancelled";
    await d.save();
    res.send(d);
  })
);

router.delete(
  "/eway/:id/ewb",
  ah(async (req, res) => {
    const d = await findDoc(req, "invoice", req.params.id);
    d.eway.status = "none";
    d.eway.ewbNo = "";
    d.eway.ewbDate = null;
    d.eway.validUpto = null;
    await d.save();
    res.send(d);
  })
);

module.exports = router;
