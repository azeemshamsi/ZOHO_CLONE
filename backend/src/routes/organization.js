const router = require("express").Router();
const Joi = require("joi");
const Organization = require("../models/Organization");
const { ah, validate, HttpError } = require("../utils/http");

const address = Joi.object({
  street: Joi.string().allow(""),
  city: Joi.string().allow(""),
  state: Joi.string().allow(""),
  pincode: Joi.string().allow(""),
  country: Joi.string().allow(""),
});

router.get("/", ah(async (req, res) => res.send(await Organization.findById(req.org))));

router.put(
  "/",
  ah(async (req, res) => {
    const data = validate(
      Joi.object({
        name: Joi.string().trim().min(2).required().label("Organization name"),
        gstin: Joi.string()
          .allow("")
          .uppercase()
          .pattern(/^[0-9]{2}[A-Z0-9]{13}$/)
          .messages({ "string.pattern.base": "GSTIN must be 15 characters" }),
        state: Joi.string().required().label("State"),
        address,
        email: Joi.string().allow(""),
        phone: Joi.string().allow(""),
        website: Joi.string().allow(""),
        invoicePrefix: Joi.string().allow("").max(10),
        paymentPrefix: Joi.string().allow("").max(10),
        quotePrefix: Joi.string().allow("").max(10),
        salesOrderPrefix: Joi.string().allow("").max(10),
        creditNotePrefix: Joi.string().allow("").max(10),
        vendorPaymentPrefix: Joi.string().allow("").max(10),
        journalPrefix: Joi.string().allow("").max(10),
        purchaseOrderPrefix: Joi.string().allow("").max(10),
        vendorCreditPrefix: Joi.string().allow("").max(10),
        defaultPaymentTerms: Joi.number().min(0).max(365),
        defaultNotes: Joi.string().allow(""),
        defaultTerms: Joi.string().allow(""),
      }),
      req.body
    );
    const org = await Organization.findByIdAndUpdate(req.org, data, { new: true, runValidators: true });
    res.send(org);
  })
);

// Outgoing email account: a mailbox over SMTP, or Brevo / Resend over HTTPS (works where SMTP ports are blocked).
router.put(
  "/email",
  ah(async (req, res) => {
    const data = validate(
      Joi.object({
        provider: Joi.string().valid("smtp", "brevo", "resend").default("smtp"),
        host: Joi.string().allow("").trim(),
        port: Joi.number().integer().min(1).max(65535).default(587),
        secure: Joi.boolean().default(false),
        user: Joi.string().allow("").trim(),
        pass: Joi.string().allow(""), // blank = keep the saved password
        apiKey: Joi.string().allow("").trim(), // blank = keep the saved key
        fromName: Joi.string().allow("").trim(),
      }),
      req.body
    );
    const org = await Organization.findById(req.org);
    const old = org.smtp || {};
    const api = data.provider !== "smtp";
    if (api && data.user && !data.apiKey && !(old.apiKey && old.provider === data.provider)) throw new HttpError(400, "Enter the API key");
    const pass = data.pass ? data.pass.replace(/\s+/g, "") : old.pass || "";
    const apiKey = (data.apiKey || "").replace(/\s+/g, "") || (old.provider === data.provider ? old.apiKey : "") || "";
    org.smtp = api
      ? { provider: data.provider, host: "", port: 587, secure: false, user: data.user, pass: "", apiKey: data.user ? apiKey : "", fromName: data.fromName }
      : { provider: "smtp", host: data.host, port: data.port, secure: data.secure, user: data.user, pass: data.host ? pass : "", apiKey: "", fromName: data.fromName };
    await org.save();
    res.send(org);
  })
);

router.post(
  "/email/test",
  ah(async (req, res) => {
    const org = await Organization.findById(req.org);
    await require("../utils/mailer").sendOrgMail(org, {
      to: [req.user.email],
      subject: `OrdexaGo test email for ${org.name}`,
      text: `Hi ${req.user.name},\n\nYour email settings work. Invoices, quotes and reminders will be sent from this account.\n\nMGI`,
    });
    res.send({ message: `Test email sent to ${req.user.email}` });
  })
);

router.put(
  "/reminders",
  ah(async (req, res) => {
    const data = validate(Joi.object({ enabled: Joi.boolean().required(), days: Joi.array().items(Joi.number().integer().min(0).max(365)).max(6).default([]) }), req.body);
    const org = await Organization.findByIdAndUpdate(req.org, { reminders: { enabled: data.enabled, days: [...new Set(data.days)].sort((a, b) => a - b) } }, { new: true });
    res.send(org);
  })
);

// Google Gemini key for reading scanned bills and photos (blank key = keep the saved one).
router.put(
  "/ai",
  ah(async (req, res) => {
    const d = validate(Joi.object({ geminiKey: Joi.string().allow("").trim(), model: Joi.string().allow("").trim().max(60), remove: Joi.boolean().default(false) }), req.body);
    const org = await Organization.findById(req.org);
    const old = org.ai || {};
    const key = d.remove ? "" : (d.geminiKey || "").replace(/\s+/g, "") || old.geminiKey || "";
    const model = d.remove ? "" : d.model ?? old.model ?? "";
    let resolvedModel = old.resolvedModel || "";
    let warning = "";
    if (key && (d.geminiKey || d.model !== undefined)) {
      try {
        resolvedModel = await require("../utils/aiBill").testKey(key, model);
      } catch (e) {
        if (!e.unreachable) throw e;
        // Google didn't answer in time: keep the key anyway; reading bills will try again.
        warning = `${e.message}. The key was saved; use Test to check it again.`;
      }
    }
    org.ai = { geminiKey: key, model, resolvedModel: key ? resolvedModel : "" };
    await org.save();
    if (warning) return res.send({ ...org.toJSON(), warning });
    res.send(org);
  })
);

router.post(
  "/ai/test",
  ah(async (req, res) => {
    const org = await Organization.findById(req.org);
    const key = org.ai?.geminiKey || process.env.GEMINI_API_KEY;
    if (!key) throw new HttpError(400, "Add a Gemini API key first");
    const model = await require("../utils/aiBill").testKey(key, org.ai?.model);
    if (org.ai?.geminiKey && org.ai.resolvedModel !== model) {
      org.ai.resolvedModel = model;
      org.markModified("ai");
      await org.save();
    }
    res.send({ message: `Gemini is connected (model ${model})` });
  })
);

module.exports = router;
