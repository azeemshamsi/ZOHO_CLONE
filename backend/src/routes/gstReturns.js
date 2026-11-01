/**
 * GST returns from the books (mounted at /api/gst/returns):
 *   GET  /gstr1?period=2026-07            summary, issues and the portal JSON (…&download=1 for the file)
 *   GET  /gstr3b?period=2026-07&itc=books|2b
 *   GET  /gstr9?fy=2025-26                annual summary (…&download=xlsx)
 *   GET  /calendar?fy=2025-26             due dates with filing status
 *   GET/POST/DELETE /filings              mark a return as filed (ARN)
 *   POST /2b {period, name, data}         upload GSTR-2B (JSON or Excel) → GET /2b?period= reconciliation
 *   PUT  /frequency {frequency}
 */
const router = require("express").Router();
const Joi = require("joi");
const Organization = require("../models/Organization");
const GstFiling = require("../models/GstFiling");
const Gstr2b = require("../models/Gstr2b");
const { ah, validate, HttpError } = require("../utils/http");
const G = require("../utils/gstReturns");

const orgOf = (req) => Organization.findById(req.org).lean();
const freqOf = (org) => org.gstFiling?.frequency || "monthly";
const sendJson = (res, name, obj) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
  res.send(JSON.stringify(obj, null, 1));
};
const filingKey = (org, form, period, freq) => (freq === "quarterly" && ["GSTR-1", "GSTR-3B"].includes(form) ? G.periodRange(period, freq).to.toISOString().slice(0, 7) : period);

router.get(
  "/gstr1",
  ah(async (req, res) => {
    const org = await orgOf(req);
    const freq = req.query.freq || freqOf(org);
    const r = await G.gstr1(org, req.query.period, freq);
    if (req.query.download) return sendJson(res, `GSTR1_${org.gstin || "GSTIN"}_${r.fp}.json`, r.json);
    const filing = await GstFiling.findOne({ organization: req.org, form: "GSTR-1", period: filingKey(org, "GSTR-1", req.query.period, freq) }).lean();
    res.send({ ...r, json: undefined, freq, filing });
  })
);

async function itc2bFor(req, org, period, freq) {
  const { from, to } = G.periodRange(period, freq);
  const months = [];
  for (let d = new Date(from); d <= to; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) months.push(d.toISOString().slice(0, 7));
  const stmts = await Gstr2b.find({ organization: req.org, period: { $in: months } }).lean();
  if (!stmts.length) return null;
  const t = { iamt: 0, camt: 0, samt: 0, months: stmts.map((s) => s.period) };
  for (const s of stmts) for (const d of s.docs) if (d.itc && !d.reverse) (t.iamt += d.iamt), (t.camt += d.camt), (t.samt += d.samt);
  for (const k of ["iamt", "camt", "samt"]) t[k] = Math.round(t[k] * 100) / 100;
  return t;
}

router.get(
  "/gstr3b",
  ah(async (req, res) => {
    const org = await orgOf(req);
    const freq = req.query.freq || freqOf(org);
    const from2b = await itc2bFor(req, org, req.query.period, freq);
    const r = await G.gstr3b(org, req.query.period, freq, { itcFrom2b: req.query.itc === "2b" ? from2b : null });
    if (req.query.download) return sendJson(res, `GSTR3B_${org.gstin || "GSTIN"}_${r.fp}.json`, r.json);
    const filing = await GstFiling.findOne({ organization: req.org, form: "GSTR-3B", period: filingKey(org, "GSTR-3B", req.query.period, freq) }).lean();
    res.send({ ...r, json: undefined, freq, filing, itc2bAvailable: from2b });
  })
);

router.get(
  "/gstr9",
  ah(async (req, res) => {
    const org = await orgOf(req);
    const r = await G.gstr9(org, req.query.fy);
    if (req.query.download === "xlsx") {
      const XLSX = require("xlsx");
      const wb = XLSX.utils.book_new();
      const amt = (o) => [o.txval ?? "", o.iamt ?? "", o.camt ?? "", o.samt ?? ""];
      const head = ["", "Taxable value", "IGST", "CGST", "SGST"];
      const sheet = (title, rows) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), title);
      sheet("Summary", [
        [`GSTR-9 working — ${org.name} (${org.gstin || "no GSTIN"}) — FY ${r.fy}`],
        [],
        ["Table 4 · Outward supplies on which tax is payable"],
        head,
        ...Object.entries(r.table4).map(([k, v]) => [k, ...amt(v)]),
        [],
        ["Table 5 · Supplies without tax"],
        ...Object.entries(r.table5).map(([k, v]) => [k, v.txval]),
        [],
        ["Tables 6–7 · Input tax credit"],
        head,
        ...Object.entries(r.table6).map(([k, v]) => [k, "", v.iamt, v.camt, v.samt]),
        [],
        ["Table 9 · Tax payable and paid"],
        ["", "", "IGST", "CGST", "SGST"],
        ["Tax payable", "", r.table9.payable.iamt, r.table9.payable.camt, r.table9.payable.samt],
        ["Paid in cash", "", r.table9.paidThroughItc.cash.iamt, r.table9.paidThroughItc.cash.camt, r.table9.paidThroughItc.cash.samt],
      ]);
      const hsnRows = (list) => [["HSN", "UQC", "Quantity", "Rate %", "Taxable value", "IGST", "CGST", "SGST"], ...list.map((h) => [h.hsn, h.uqc, h.qty, h.rate, h.txval, h.iamt, h.camt, h.samt])];
      sheet("Table 17 HSN outward", hsnRows(r.table17));
      sheet("Table 18 HSN inward", hsnRows(r.table18));
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="GSTR9_${org.gstin || "GSTIN"}_${r.fy}.xlsx"`);
      return res.send(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
    }
    const filing = await GstFiling.findOne({ organization: req.org, form: "GSTR-9", period: r.fy }).lean();
    res.send({ ...r, filing });
  })
);

router.get(
  "/calendar",
  ah(async (req, res) => {
    const org = await orgOf(req);
    const fy = req.query.fy || (() => {
      const t = require("../utils/time").istToday();
      const y = t.getUTCMonth() >= 3 ? t.getUTCFullYear() : t.getUTCFullYear() - 1;
      return `${y}-${String(y + 1).slice(2)}`;
    })();
    const filings = await GstFiling.find({ organization: req.org }).lean();
    res.send({ fy, frequency: freqOf(org), gstin: org.gstin, state: org.state, items: G.calendar(org, fy, filings) });
  })
);

router.put(
  "/frequency",
  ah(async (req, res) => {
    const d = validate(Joi.object({ frequency: Joi.string().valid("monthly", "quarterly").required() }), req.body);
    await Organization.updateOne({ _id: req.org }, { $set: { "gstFiling.frequency": d.frequency } });
    res.send({ frequency: d.frequency });
  })
);

router.get(
  "/filings",
  ah(async (req, res) => res.send(await GstFiling.find({ organization: req.org }).sort({ filedOn: -1 }).lean()))
);
router.post(
  "/filings",
  ah(async (req, res) => {
    const d = validate(
      Joi.object({
        form: Joi.string().max(40).required(),
        period: Joi.string().max(40).required(),
        arn: Joi.string().allow("").max(40),
        filedOn: Joi.date().required(),
        amountPaid: Joi.number().min(0).default(0),
        notes: Joi.string().allow("").max(500),
        summary: Joi.any(),
      }),
      req.body
    );
    const org = await orgOf(req);
    const period = filingKey(org, d.form, d.period, freqOf(org));
    const f = await GstFiling.findOneAndUpdate({ organization: req.org, form: d.form, period }, { ...d, period, by: req.user.name }, { upsert: true, new: true, setDefaultsOnInsert: true });
    res.status(201).send(f);
  })
);
router.delete(
  "/filings/:id",
  ah(async (req, res) => {
    await GstFiling.deleteOne({ _id: req.params.id, organization: req.org });
    res.send({ ok: true });
  })
);

/* ----------------------------- GSTR-2B ----------------------------- */
router.post(
  "/2b",
  ah(async (req, res) => {
    const d = validate(Joi.object({ period: Joi.string().pattern(/^\d{4}-\d{2}$/).required(), name: Joi.string().allow(""), data: Joi.string().required() }), req.body);
    const buf = Buffer.from(d.data.replace(/^data:[^,]*,/, ""), "base64");
    const { docs, gstin, period } = G.parse2b(buf, d.name);
    const org = await orgOf(req);
    if (gstin && org.gstin && gstin.toUpperCase() !== org.gstin.toUpperCase()) throw new HttpError(400, `That GSTR-2B is for ${gstin}, not this company (${org.gstin}). Switch company or upload the right file.`);
    // The file knows its own period (MMYYYY); trust it over the picker.
    let p = d.period;
    if (/^\d{6}$/.test(period)) p = `${period.slice(2)}-${period.slice(0, 2)}`;
    await Gstr2b.findOneAndUpdate({ organization: req.org, period: p }, { docs, fileName: d.name || "", by: req.user.name, accepted: [] }, { upsert: true, new: true });
    res.status(201).send({ period: p, count: docs.length });
  })
);

router.get(
  "/2b",
  ah(async (req, res) => {
    const org = await orgOf(req);
    const list = await Gstr2b.find({ organization: req.org }, { docs: 0, accepted: 0 }).sort({ period: -1 }).lean();
    if (!req.query.period) return res.send({ statements: list.map(({ docs, ...s }) => s) });
    const stmt = await Gstr2b.findOne({ organization: req.org, period: req.query.period }).lean();
    if (!stmt) return res.send({ statements: list.map(({ docs, ...s }) => s), statement: null });
    const { from, to } = G.periodRange(req.query.period, "monthly");
    const docs = stmt.docs.map((x) => ({ ...x, date: x.date ? new Date(x.date) : null }));
    const r = await G.reconcile(org, docs, from, to, { tolerance: Number(req.query.tolerance) || 1 });
    const acc = new Set(stmt.accepted || []);
    for (const row of r.rows) if (row.portal && acc.has(`${row.gstin}|${row.portal.number}`) && ["mismatch", "probable"].includes(row.status)) row.status = "matched", (row.accepted = true);
    res.send({ statements: list.map(({ docs: _d, ...s }) => s), statement: { period: stmt.period, fileName: stmt.fileName, by: stmt.by, updatedAt: stmt.updatedAt, count: stmt.docs.length }, ...r });
  })
);

router.post(
  "/2b/:period/accept",
  ah(async (req, res) => {
    const d = validate(Joi.object({ key: Joi.string().required(), accept: Joi.boolean().default(true) }), req.body);
    await Gstr2b.updateOne({ organization: req.org, period: req.params.period }, d.accept ? { $addToSet: { accepted: d.key } } : { $pull: { accepted: d.key } });
    res.send({ ok: true });
  })
);

router.delete(
  "/2b/:period",
  ah(async (req, res) => {
    await Gstr2b.deleteOne({ organization: req.org, period: req.params.period });
    res.send({ ok: true });
  })
);

module.exports = router;
