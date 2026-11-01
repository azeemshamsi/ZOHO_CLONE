const router = require("express").Router();
const Joi = require("joi");
const Organization = require("../models/Organization");
const EmailLog = require("../models/EmailLog");
const { DOCS, load, pdfFor, fileName } = require("../utils/documents");
const { sendOrgMail, canEmail } = require("../utils/mailer");
const { reminderBody } = require("../utils/reminders");
const { ah, validate } = require("../utils/http");

const org = (req) => Organization.findById(req.org);

// PDF to view or download.
router.get(
  "/:kind/:id/pdf",
  ah(async (req, res) => {
    const o = await org(req);
    const { cfg, d } = await load(o, req.params.kind, req.params.id);
    const buf = await pdfFor(o, req.params.kind, d);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `${req.query.download ? "attachment" : "inline"}; filename="${fileName(cfg, d)}"`);
    res.send(buf);
  })
);

// What the email dialog starts with, plus emails already sent.
router.get(
  "/:kind/:id/email",
  ah(async (req, res) => {
    const o = await org(req);
    const { cfg, d, contact } = await load(o, req.params.kind, req.params.id);
    const name = contact?.displayName || d[`${cfg.party}Name`];
    const reminder = req.query.type === "reminder";
    const history = await EmailLog.find({ organization: req.org, docId: d._id }).sort({ createdAt: -1 }).lean();
    res.send({
      canEmail: canEmail(o),
      to: contact?.email ? [contact.email] : [],
      cc: [],
      subject: reminder ? `Payment reminder: Invoice ${d.invoiceNumber} is overdue` : `${cfg.label} ${d[cfg.number]} from ${o.name}`,
      body: reminder ? reminderBody(d, o, name) : cfg.body(d, o, name),
      fileName: fileName(cfg, d),
      history,
    });
  })
);

const emails = Joi.array().items(Joi.string().trim().email().label("Email address"));
router.post(
  "/:kind/:id/email",
  ah(async (req, res) => {
    const data = validate(
      Joi.object({
        to: emails.min(1).required().label("To"),
        cc: emails.default([]),
        subject: Joi.string().trim().required().label("Subject"),
        body: Joi.string().allow("").default(""),
        attachPdf: Joi.boolean().default(true),
        type: Joi.string().valid("document", "reminder").default("document"),
      }),
      req.body
    );
    const o = await org(req);
    const { cfg, d } = await load(o, req.params.kind, req.params.id);
    const attachments = data.attachPdf ? [{ filename: fileName(cfg, d), content: await pdfFor(o, req.params.kind, d) }] : [];
    await sendOrgMail(o, { to: data.to, cc: data.cc, subject: data.subject, text: data.body, attachments, replyTo: req.user.email });
    const type = data.type === "reminder" ? "reminder" : cfg.receipt ? "receipt" : "document";
    await EmailLog.create({ organization: req.org, kind: req.params.kind, docId: d._id, type, to: data.to, cc: data.cc, subject: data.subject, sentBy: req.user.name });
    if (cfg.markSent && cfg.markSent(d)) await d.save();
    res.send({ message: `Email sent to ${data.to.join(", ")}`, status: d.status });
  })
);

module.exports = router;
module.exports.moduleOf = (req) => (DOCS[req.path.split("/")[1]] || { module: "sales" }).module;
