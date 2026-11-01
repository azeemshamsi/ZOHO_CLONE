/**
 * Bills from a PDF: read the supplier's bill, then create a purchase bill or an expense with the PDF attached.
 *   POST /read   { name, data }            → what was found (nothing saved)
 *   POST /create { kind, draft…, name, data } → creates vendor (if new), the bill/expense, and the attachment
 */
const router = require("express").Router();
const Joi = require("joi");
const Organization = require("../models/Organization");
const Vendor = require("../models/Vendor");
const Branch = require("../models/Branch");
const { ah, validate, HttpError } = require("../utils/http");
const { pdfText, parseBill } = require("../utils/billparse");
const { call } = require("../utils/import/commit");
const { store } = require("./attachments");

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const iso = (d) => (d ? new Date(new Date(d).getTime() + 5.5 * 3600000).toISOString().slice(0, 10) : "");

router.post(
  "/read",
  ah(async (req, res) => {
    const d = validate(Joi.object({ name: Joi.string().required(), data: Joi.string().required() }), req.body);
    const buf = Buffer.from(d.data.replace(/^data:.*?;base64,/, ""), "base64");
    if (buf.length > 10 * 1024 * 1024) throw new HttpError(400, "Files can be up to 10 MB");
    const isPdf = buf.slice(0, 5).toString() === "%PDF-";
    if (!isPdf) return res.send({ scanned: true, message: "This isn't a PDF, so there's no text to read. Fill in the details; the file will still be attached." });
    let lines;
    try {
      lines = await pdfText(buf);
    } catch (e) {
      throw new HttpError(400, `Couldn't read this PDF: ${e.message}`);
    }
    if (lines.join("").replace(/\s/g, "").length < 40) return res.send({ scanned: true, message: "This PDF is a scanned image with no text in it. Fill in the details below; the PDF will be attached." });
    const org = await Organization.findById(req.org);
    const branches = await Branch.find({ organization: req.org }, { gstin: 1 }).lean();
    const p = parseBill(lines, { ownGstins: [org.gstin, ...branches.map((b) => b.gstin)] });
    let vendor = null;
    if (p.supplierGstin) vendor = await Vendor.findOne({ organization: req.org, gstin: p.supplierGstin }).lean();
    if (!vendor && p.supplierName) vendor = await Vendor.findOne({ organization: req.org, displayName: new RegExp(`^${esc(p.supplierName)}$`, "i") }).lean();
    res.send({ ...p, date: iso(p.date), dueDate: iso(p.dueDate), vendor: vendor ? { _id: vendor._id, name: vendor.displayName, gstin: vendor.gstin } : null, preview: lines.slice(0, 60) });
  })
);

router.post(
  "/create",
  ah(async (req, res) => {
    const d = validate(
      Joi.object({
        kind: Joi.string().valid("bill", "expense").required(),
        vendorId: Joi.string().allow("", null),
        vendorName: Joi.string().allow(""),
        vendorGstin: Joi.string().allow("").uppercase(),
        billNumber: Joi.string().allow(""),
        date: Joi.date().required().label("Bill date"),
        dueDate: Joi.date().allow(null, ""),
        placeOfSupply: Joi.string().allow(""),
        description: Joi.string().allow(""),
        hsn: Joi.string().allow(""),
        taxable: Joi.number().min(0).required().label("Taxable value"),
        rate: Joi.number().min(0).max(100).default(0),
        adjustment: Joi.number().default(0),
        account: Joi.string().allow(""), // expense account / category
        paidThrough: Joi.string().allow(""),
        status: Joi.string().valid("draft", "open").default("draft"),
        name: Joi.string().allow(""),
        data: Joi.string().allow(""),
      }),
      req.body
    );
    const ctx = { org: req.org, user: req.user };
    const org = await Organization.findById(req.org);
    // Vendor: chosen, or found by GSTIN, or created.
    let vendor = d.vendorId ? await Vendor.findOne({ _id: d.vendorId, organization: req.org }) : null;
    if (!vendor && d.vendorGstin) vendor = await Vendor.findOne({ organization: req.org, gstin: d.vendorGstin });
    if (!vendor && d.vendorName) vendor = await Vendor.findOne({ organization: req.org, displayName: new RegExp(`^${esc(d.vendorName)}$`, "i") });
    let created = false;
    if (!vendor && (d.vendorName || d.vendorGstin)) {
      created = true;
      vendor = await Vendor.create({ organization: req.org, displayName: d.vendorName || d.vendorGstin, gstin: d.vendorGstin || "", gstTreatment: d.vendorGstin ? "registered" : "unregistered", placeOfSupply: (d.vendorGstin || "").slice(0, 2) || d.placeOfSupply || org.state, billingAddress: { state: (d.vendorGstin || "").slice(0, 2) || d.placeOfSupply || org.state } });
    }
    const pos = d.placeOfSupply || (vendor?.gstin || d.vendorGstin || "").slice(0, 2) || org.state;
    const dateIso = iso(d.date);
    let doc;
    let docType;
    if (d.kind === "bill") {
      if (!vendor) throw new HttpError(400, "Choose or enter the supplier");
      doc = await call(require("./bills"), "POST", "/", ctx, {
        vendor: String(vendor._id),
        billNumber: d.billNumber || `BILL-${dateIso}`,
        date: dateIso,
        dueDate: d.dueDate ? iso(d.dueDate) : dateIso,
        status: d.status,
        placeOfSupply: pos,
        adjustment: d.adjustment || 0,
        lineItems: [{ name: d.description || `As per bill ${d.billNumber || ""}`.trim(), hsnSac: d.hsn || "", quantity: 1, rate: d.taxable, taxRate: d.rate }],
      });
      docType = "bill";
    } else {
      const cats = await call(require("./expenses"), "GET", "/categories", ctx);
      const category = d.account && cats.includes(d.account) ? d.account : cats[0];
      doc = await call(require("./expenses"), "POST", "/", ctx, {
        date: dateIso,
        category,
        amount: d.taxable,
        taxRate: d.rate || 0,
        taxInclusive: false,
        vendor: vendor ? String(vendor._id) : null,
        paidThrough: d.paidThrough === "cash" ? "cash" : "bank_transfer",
        reference: (d.billNumber || "").slice(0, 100),
        notes: d.description || "",
      });
      docType = "expense";
    }
    let attachment = null;
    if (d.data) attachment = await store(req, { docType, docId: doc._id, name: d.name || `${docType}.pdf`, type: (d.data.match(/^data:(.*?);/) || [])[1] || "application/pdf", buf: Buffer.from(d.data.replace(/^data:.*?;base64,/, ""), "base64") });
    res.status(201).send({ docType, _id: doc._id, number: doc.billNumber || doc.reference || "", total: doc.total ?? doc.amount, attachment: !!attachment, vendorCreated: created });
  })
);

module.exports = router;
