const router = require("express").Router();
const Joi = require("joi");
const Account = require("../models/Account");
const { ACCOUNT_TYPES } = require("../models/Account");
const { ah, validate, HttpError, round2 } = require("../utils/http");
const { chartOfAccounts, buildEntries, movements, naturalBalance, TYPE_ORDER, debitNormal, parseRange } = require("../utils/ledger");

const schema = Joi.object({
  name: Joi.string().trim().min(1).max(120).required().label("Account name"),
  group: Joi.string()
    .valid(...Object.keys(ACCOUNT_TYPES))
    .required()
    .label("Account type"),
  accountCode: Joi.string().allow(""),
  description: Joi.string().allow(""),
  active: Joi.boolean(),
});

router.get("/types", (req, res) => res.send(Object.keys(ACCOUNT_TYPES)));

// All accounts with their balance as of today (or ?to=YYYY-MM-DD).
router.get(
  "/",
  ah(async (req, res) => {
    const to = req.query.to ? new Date(`${req.query.to}T23:59:59.999Z`) : new Date();
    const [accounts, entries] = await Promise.all([chartOfAccounts(req.org), buildEntries(req.org, { to })]);
    const mv = movements(entries);
    let list = accounts.map((a) => ({ ...a, balance: naturalBalance(a, mv[a.code]) }));
    if (req.query.type) list = list.filter((a) => a.type === req.query.type);
    list.sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) || a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
    res.send(list);
  })
);

router.post(
  "/",
  ah(async (req, res) => {
    const data = validate(schema, req.body);
    const existing = await chartOfAccounts(req.org);
    if (existing.some((a) => a.name.toLowerCase() === data.name.toLowerCase())) {
      throw new HttpError(409, "An account with this name already exists");
    }
    res.status(201).send(await Account.create({ ...data, organization: req.org }));
  })
);

// One account's transactions with a running balance.
router.get(
  "/:code/transactions",
  ah(async (req, res) => {
    const accounts = await chartOfAccounts(req.org);
    const acc = accounts.find((a) => a.code === req.params.code);
    if (!acc) throw new HttpError(404, "Account not found");
    const { from, to } = parseRange(req.query);
    const entries = await buildEntries(req.org, { to });
    const sign = debitNormal(acc.type) ? 1 : -1;
    let opening = 0;
    const rows = [];
    for (const e of entries) {
      for (const l of e.lines) {
        if (l.account !== acc.code) continue;
        const net = sign * (l.debit - l.credit);
        if (from && new Date(e.date) < from) {
          opening += net;
          continue;
        }
        rows.push({ date: e.date, type: e.type, id: e.id, number: e.number, party: e.party, debit: l.debit, credit: l.credit });
      }
    }
    opening = round2(opening);
    let run = opening;
    for (const r of rows) {
      run = round2(run + sign * (r.debit - r.credit));
      r.balance = run;
    }
    res.send({ account: acc, from, to, opening, closing: run, rows });
  })
);

router.put(
  "/:code",
  ah(async (req, res) => {
    const data = validate(schema, req.body);
    const acc = await Account.findOne({ _id: req.params.code, organization: req.org }).catch(() => null);
    if (!acc) throw new HttpError(400, "Built-in accounts can't be edited");
    acc.set(data);
    await acc.save();
    res.send(acc);
  })
);

router.delete(
  "/:code",
  ah(async (req, res) => {
    const acc = await Account.findOne({ _id: req.params.code, organization: req.org }).catch(() => null);
    if (!acc) throw new HttpError(400, "Built-in accounts can't be deleted");
    const entries = await buildEntries(req.org);
    if (entries.some((e) => e.lines.some((l) => l.account === req.params.code))) {
      throw new HttpError(400, "This account has transactions. Mark it inactive instead.");
    }
    await acc.deleteOne();
    res.send({ message: "Account deleted" });
  })
);

module.exports = router;
