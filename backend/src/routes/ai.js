/**
 * AI features (Google Gemini, the company's own key):
 *  POST /ask            "Ask OrdexaGo" — questions answered from the user's own data (read-only, their permissions)
 *  GET  /insights       a short daily summary: what needs attention today
 *  POST /bank-suggest   ledger / party suggestions for bank lines the rules didn't catch (learns from past picks)
 *  POST /item-suggest   description, HSN code and GST rate for an item
 */
const router = require("express").Router();
const Joi = require("joi");
const Organization = require("../models/Organization");
const BankStatementLine = require("../models/BankStatementLine");
const Customer = require("../models/Customer");
const Vendor = require("../models/Vendor");
const { ah, validate, HttpError } = require("../utils/http");
const { chartOfAccounts } = require("../utils/ledger");
const { ask, AiError } = require("../utils/ai/gemini");
const assistant = require("../utils/ai/assistant");

const wrap = (fn) =>
  ah(async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (e instanceof AiError) throw new HttpError(e.status || 400, e.message);
      throw e;
    }
  });
const orgOf = (req) => Organization.findById(req.org);
const has = (req, mod, need = "view") => {
  const rank = { none: 0, view: 1, full: 2 };
  return req.user?.superadmin || req.user?.role === "admin" || rank[req.perms?.[mod] || "none"] >= rank[need];
};

/* ---------- Ask OrdexaGo ---------- */
router.post(
  "/ask",
  wrap(async (req, res) => {
    const d = validate(
      Joi.object({
        messages: Joi.array()
          .items(Joi.object({ role: Joi.string().valid("user", "model").required(), text: Joi.string().allow("").max(8000).required() }))
          .min(1)
          .max(30)
          .required(),
      }),
      req.body,
    );
    const history = d.messages.slice(-12);
    if (history[history.length - 1].role !== "user") throw new HttpError(400, "Ask a question");
    const r = await assistant.answer(req, await orgOf(req), history);
    res.send({ text: r.text, used: [...new Set(r.used)] });
  }),
);

/* ---------- Daily insights ---------- */
const insightCache = new Map(); // org|user|day → { at, text }
router.get(
  "/insights",
  wrap(async (req, res) => {
    const day = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
    const key = `${req.org}|${req.user._id}|${day}`;
    const hit = insightCache.get(key);
    if (hit && !req.query.refresh) return res.send(hit);
    const prompt = `Give me today's business briefing: the 4–7 things that most need my attention right now, most important first.
Look at: overdue receivables (biggest customers / marketplaces owing), payables falling due, cash and bank position, this month's sales and expenses compared with last month (call out unusual jumps), store orders pending dispatch and RTO / returns in the last 30 days (by courier if one stands out), and items running out of stock if you can see stock.
Format: a one-line headline, then short bullet points, each with the number and what to do. No preamble. Skip anything you couldn't see.`;
    const r = await assistant.answer(req, await orgOf(req), [{ role: "user", text: prompt }]);
    const out = { at: new Date(), text: r.text };
    insightCache.set(key, out);
    if (insightCache.size > 500) insightCache.delete(insightCache.keys().next().value);
    res.send(out);
  }),
);

/* ---------- Bank line suggestions ---------- */
const words = (s) => String(s || "").toUpperCase().match(/[A-Z][A-Z0-9&]{3,}/g) || [];
const COMMON = new Set(["NEFT", "IMPS", "RTGS", "UPI", "BANK", "LTD", "LIMITED", "PRIVATE", "PVT", "INDIA", "PAYMENT", "PAYMENTS", "TRANSFER", "INTERNAL", "SETTLEMENT", "ACCOUNT", "HDFC", "ICICI", "AXIS", "SBIN", "STATE", "CREDIT", "DEBIT", "SERVICES", "SERVICE", "CHARGES", "INTERMEDIERY", "FROM", "THE", "AND"]);

router.post(
  "/bank-suggest",
  wrap(async (req, res) => {
    if (!has(req, "banking", "full")) throw new HttpError(403, "You don't have access to categorise bank lines");
    const d = validate(Joi.object({ account: Joi.string().required(), ids: Joi.array().items(Joi.string()).max(60).default([]) }), req.body);
    const filter = { organization: req.org, account: d.account, status: "unmatched" };
    if (d.ids.length) filter._id = { $in: d.ids };
    const lines = await BankStatementLine.find(filter).sort({ date: -1 }).limit(40).lean();
    if (!lines.length) return res.send({ suggestions: [] });

    const accounts = (await chartOfAccounts(req.org)).filter((a) => a.active !== false && !["ar", "ap", d.account].includes(a.code) && !["Bank"].includes(a.group) && a.code !== "inventory");
    const ledgerList = accounts.map((a) => `${a.code} | ${a.name} | ${a.type}${a.group ? ` / ${a.group}` : ""}`);

    // What this company picked before for similar lines (the "learning").
    const past = (
      await BankStatementLine.find({ organization: req.org, status: "categorized" }, { description: 1, deposit: 1, withdrawal: 1, match: 1 })
        .sort({ updatedAt: -1 })
        .limit(1500)
        .lean()
    ).filter((p) => p.match?.account);
    const tokens = new Set(lines.flatMap((l) => words(l.description)).filter((w) => !COMMON.has(w)));
    const score = (p) => words(p.description).filter((w) => tokens.has(w)).length;
    const examples = past
      .map((p) => ({ p, s: score(p) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 80)
      .map(({ p }) => `"${String(p.description).slice(0, 140)}" ${p.deposit ? "IN" : "OUT"} ₹${p.deposit || p.withdrawal} → ${p.match.account}${p.match.party ? ` (${p.match.party})` : ""}`);

    // Customers / vendors whose name appears in these lines (+ those used before).
    const usedParty = new Set(past.map((p) => p.match.account).filter((a) => String(a).startsWith("party:")));
    const [customers, vendors] = await Promise.all([
      Customer.find({ organization: req.org }, { displayName: 1, companyName: 1 }).lean(),
      Vendor.find({ organization: req.org }, { displayName: 1, companyName: 1 }).lean(),
    ]);
    const partyLines = [];
    for (const [kind, list] of [["vendor", vendors], ["customer", customers]])
      for (const c of list) {
        const v = `party:${kind}:${c._id}`;
        const nameWords = words(`${c.displayName} ${c.companyName || ""}`).filter((w) => !COMMON.has(w));
        if (usedParty.has(v) || nameWords.some((w) => tokens.has(w))) partyLines.push(`${v} | ${c.displayName} | ${kind}`);
      }

    const prompt = `You categorise Indian business bank-statement lines into the company's ledgers (Tally-style accounting).
For each line choose the best "account" value from LEDGERS or PARTIES below (copy the value exactly), or "" if you aren't reasonably sure.
- A payment to / receipt from a known vendor or customer (including marketplaces like Amazon, Flipkart, payment gateways settling sales such as Cashfree / Razorpay when they are set up as customers) → their party value.
- Bank charges, GST on charges → a bank charges expense ledger; interest received → interest income; ads (Facebook / Meta, Google) → advertising; courier companies (Blue Dart, Delhivery…) → their vendor if listed, else a courier/freight expense ledger; cash withdrawal → Cash ledger; owner transfers → drawings / capital.
- Follow the company's PAST CHOICES whenever a line looks like one of them — they override general rules.
- taxRate: GST % included in an expense payment (0 if unknown / not an expense).
Return JSON: {"suggestions":[{"id":"<line id>","account":"<value or empty>","taxRate":0,"confidence":0.0-1.0,"reason":"<max 12 words>"}]}

LEDGERS (code | name | type / group):
${ledgerList.join("\n")}

PARTIES (value | name | kind):
${partyLines.slice(0, 300).join("\n") || "(none matched)"}

PAST CHOICES (description, direction, amount → account):
${examples.join("\n") || "(none yet)"}

LINES:
${lines.map((l) => `${l._id} | ${new Date(l.date).toISOString().slice(0, 10)} | ${l.deposit ? "IN" : "OUT"} ₹${l.deposit || l.withdrawal} | ${String(l.description).slice(0, 200)}${l.reference ? ` | ref ${l.reference}` : ""}`).join("\n")}`;

    const out = await ask(await orgOf(req), prompt, { json: true, temperature: 0.1, maxTokens: 8192 });
    const valid = new Set([...accounts.map((a) => a.code), ...partyLines.map((p) => p.split(" | ")[0])]);
    const label = Object.fromEntries([...accounts.map((a) => [a.code, a.name]), ...partyLines.map((p) => [p.split(" | ")[0], p.split(" | ")[1]])]);
    const byId = new Set(lines.map((l) => String(l._id)));
    const suggestions = (out.suggestions || [])
      .filter((s) => byId.has(String(s.id)) && s.account && valid.has(s.account))
      .map((s) => ({
        id: String(s.id),
        account: s.account,
        label: label[s.account],
        taxRate: [0, 5, 12, 18, 28, 40].includes(Number(s.taxRate)) ? Number(s.taxRate) : 0,
        confidence: Math.max(0, Math.min(1, Number(s.confidence) || 0)),
        reason: String(s.reason || "").slice(0, 120),
      }));
    res.send({ suggestions });
  }),
);

/* ---------- Item description / HSN / GST ---------- */
router.post(
  "/item-suggest",
  wrap(async (req, res) => {
    if (!has(req, "items", "full")) throw new HttpError(403, "You don't have access to edit items");
    const d = validate(
      Joi.object({
        name: Joi.string().trim().min(2).max(300).required(),
        sku: Joi.string().allow("").max(100).default(""),
        description: Joi.string().allow("").max(3000).default(""),
        unit: Joi.string().allow("").max(30).default(""),
        type: Joi.string().allow("").max(30).default(""),
        material: Joi.string().allow("").max(200).default(""),
      }),
      req.body,
    );
    const org = await orgOf(req);
    const prompt = `You help an Indian business (${org.name || "a seller"}${org.industry ? `, ${org.industry}` : ""}) fill in an item in its accounting / inventory software.
Item: "${d.name}"${d.sku ? `, SKU ${d.sku}` : ""}${d.unit ? `, unit ${d.unit}` : ""}${d.type ? `, a ${d.type}` : ""}${d.material ? `, material: ${d.material}` : ""}.
${d.description ? `Current description: ${d.description}\n` : ""}
Return JSON:
{"description": "<2–3 plain sentences for invoices and the online store: what it is, material/finish/size if evident from the name, use. No hype, no emojis, no claims not supported by the name>",
 "hsn": "<most likely HSN code, 8 digits if you can, else 6 or 4>",
 "hsnTitle": "<short title of that HSN heading>",
 "gstRate": <GST % for that HSN under India's current rates (after the September 2025 GST rate rationalisation the main slabs are 0, 5, 18 and 40)>,
 "confidence": <0-1>,
 "note": "<one short line on what could change the HSN / rate (e.g. material), if anything>"}`;
    const out = await ask(org, prompt, { json: true, temperature: 0.2 });
    res.send({
      description: String(out.description || "").slice(0, 1500),
      hsn: String(out.hsn || "").replace(/[^0-9]/g, "").slice(0, 8),
      hsnTitle: String(out.hsnTitle || "").slice(0, 200),
      gstRate: Number.isFinite(Number(out.gstRate)) ? Number(out.gstRate) : null,
      confidence: Math.max(0, Math.min(1, Number(out.confidence) || 0)),
      note: String(out.note || "").slice(0, 300),
    });
  }),
);

module.exports = router;
