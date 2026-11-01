const router = require("express").Router();
const Joi = require("joi");
const BankRule = require("../models/BankRule");
const BankStatementLine = require("../models/BankStatementLine");
const { ah, validate, HttpError } = require("../utils/http");
const { chartOfAccounts } = require("../utils/ledger");
const { ruleMatches } = require("../utils/bankActions");

const schema = Joi.object({
  name: Joi.string().trim().min(1).max(120).required().label("Rule name"),
  applyTo: Joi.string().valid("withdrawals", "deposits").required().label("Apply to"),
  accounts: Joi.array().items(Joi.string()).default([]),
  match: Joi.string().valid("any", "all").default("any"),
  conditions: Joi.array()
    .items(
      Joi.object({
        field: Joi.string().valid("description", "reference", "amount").required(),
        op: Joi.string().valid("contains", "not_contains", "equals", "starts_with", "ends_with", "greater_than", "less_than").required(),
        value: Joi.string().trim().min(1).required().label("Condition value"),
      })
    )
    .min(1)
    .required()
    .label("Conditions"),
  account: Joi.string().required().label("Account"),
  taxRate: Joi.number().min(0).max(100).default(0),
  notes: Joi.string().allow(""),
  active: Joi.boolean().default(true),
});

async function check(req, data) {
  const accounts = await chartOfAccounts(req.org);
  const target = accounts.find((a) => a.code === data.account);
  if (!target) throw new HttpError(400, "Pick the account to record these lines in");
  if (["ar", "ap"].includes(target.code)) throw new HttpError(400, "Rules can't post to receivables or payables");
  const banks = new Set(accounts.filter((a) => ["Cash", "Bank"].includes(a.group)).map((a) => a.code));
  if (data.accounts.some((c) => !banks.has(c))) throw new HttpError(400, "Pick valid bank accounts");
  if (data.accounts.includes(data.account)) throw new HttpError(400, "A rule can't record a line against its own bank account");
  for (const c of data.conditions) {
    if (c.field === "amount" && !["equals", "greater_than", "less_than"].includes(c.op)) {
      throw new HttpError(400, "For amounts use equals, greater than or less than");
    }
    if (c.field !== "amount" && ["greater_than", "less_than"].includes(c.op)) {
      throw new HttpError(400, "Greater than / less than only work with amounts");
    }
  }
  if (data.applyTo === "deposits" || target.type !== "expense") data.taxRate = 0;
  return { data, target };
}

router.get(
  "/",
  ah(async (req, res) => {
    const [rules, accounts] = await Promise.all([BankRule.find({ organization: req.org }).sort({ priority: 1, createdAt: 1 }).lean(), chartOfAccounts(req.org)]);
    const name = (c) => (accounts.find((a) => a.code === c) || { name: "Deleted account" }).name;
    res.send(rules.map((r) => ({ ...r, accountName: name(r.account), accountNames: r.accounts.map(name) })));
  })
);

router.post(
  "/",
  ah(async (req, res) => {
    const { data } = await check(req, validate(schema, req.body));
    const last = await BankRule.findOne({ organization: req.org }).sort({ priority: -1 });
    res.status(201).send(await BankRule.create({ ...data, organization: req.org, priority: last ? last.priority + 1 : 0 }));
  })
);

// Which unmatched statement lines would this rule catch right now?
router.post(
  "/preview",
  ah(async (req, res) => {
    const { data } = await check(req, validate(schema, req.body));
    const filter = { organization: req.org, status: "unmatched" };
    if (data.accounts.length) filter.account = { $in: data.accounts };
    const lines = await BankStatementLine.find(filter).sort({ date: -1 }).limit(2000).lean();
    const hits = lines.filter((l) => ruleMatches({ ...data, active: true }, l));
    res.send({ count: hits.length, sample: hits.slice(0, 8) });
  })
);

router.post(
  "/reorder",
  ah(async (req, res) => {
    const { ids } = validate(Joi.object({ ids: Joi.array().items(Joi.string()).min(1).required() }), req.body);
    await Promise.all(ids.map((id, i) => BankRule.updateOne({ _id: id, organization: req.org }, { priority: i })));
    res.send({ message: "Order saved" });
  })
);

router.put(
  "/:id",
  ah(async (req, res) => {
    const rule = await BankRule.findOne({ _id: req.params.id, organization: req.org });
    if (!rule) throw new HttpError(404, "Rule not found");
    const { data } = await check(req, validate(schema, req.body));
    rule.set(data);
    await rule.save();
    res.send(rule);
  })
);

router.delete(
  "/:id",
  ah(async (req, res) => {
    const r = await BankRule.deleteOne({ _id: req.params.id, organization: req.org });
    if (!r.deletedCount) throw new HttpError(404, "Rule not found");
    res.send({ message: "Rule deleted" });
  })
);

module.exports = router;
