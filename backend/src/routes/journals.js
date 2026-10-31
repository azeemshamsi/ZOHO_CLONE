const router = require("express").Router();
const Joi = require("joi");
const Journal = require("../models/Journal");
const Organization = require("../models/Organization");
const { nextNumber } = require("../models/Counter");
const { ah, validate, HttpError, round2 } = require("../utils/http");
const { chartOfAccounts } = require("../utils/ledger");
const { escapeRx, peekNumber } = require("../utils/salesDoc");

const schema = Joi.object({
  number: Joi.string().trim().allow(""),
  date: Joi.date().required().label("Date"),
  reference: Joi.string().allow(""),
  notes: Joi.string().allow(""),
  lines: Joi.array()
    .items(
      Joi.object({
        account: Joi.string().required().label("Account"),
        description: Joi.string().allow(""),
        debit: Joi.number().min(0).default(0),
        credit: Joi.number().min(0).default(0),
      })
    )
    .min(2)
    .required()
    .label("Lines"),
});

const prefix = (org) => org.journalPrefix || "MJ-";

async function check(req, data) {
  const accounts = await chartOfAccounts(req.org);
  const codes = new Set(accounts.map((a) => a.code));
  // Accounts receivable/payable belong to customers and vendors; post those through invoices and bills.
  const lines = data.lines
    .map((l) => ({ ...l, debit: round2(l.debit), credit: round2(l.credit) }))
    .filter((l) => l.debit > 0 || l.credit > 0);
  if (lines.length < 2) throw new HttpError(400, "A journal needs at least two lines with amounts");
  for (const l of lines) {
    if (!codes.has(l.account)) throw new HttpError(400, "One of the accounts doesn't exist");
    if (["ar", "ap"].includes(l.account)) throw new HttpError(400, "Use invoices, bills and payments for Accounts Receivable and Payable");
    if (l.debit > 0 && l.credit > 0) throw new HttpError(400, "A line can have a debit or a credit, not both");
  }
  const dr = round2(lines.reduce((s, l) => s + l.debit, 0));
  const cr = round2(lines.reduce((s, l) => s + l.credit, 0));
  if (dr !== cr) throw new HttpError(400, `Debits (${dr}) and credits (${cr}) must be equal`);
  return { lines, total: dr };
}

router.get(
  "/",
  ah(async (req, res) => {
    const filter = { organization: req.org };
    if (req.query.q) {
      const rx = escapeRx(req.query.q);
      filter.$or = [{ number: rx }, { reference: rx }, { notes: rx }];
    }
    res.send(await Journal.find(filter).sort({ date: -1, createdAt: -1 }));
  })
);

router.get(
  "/next-number",
  ah(async (req, res) => {
    const org = await Organization.findById(req.org);
    res.send({ number: await peekNumber(req.org, "journal", prefix(org)) });
  })
);

router.post(
  "/",
  ah(async (req, res) => {
    const data = validate(schema, req.body);
    const { lines, total } = await check(req, data);
    const org = await Organization.findById(req.org);
    const number = data.number || (await nextNumber(req.org, "journal", prefix(org)));
    res.status(201).send(await Journal.create({ ...data, number, lines, total, organization: req.org }));
  })
);

router.get(
  "/:id",
  ah(async (req, res) => {
    const j = await Journal.findOne({ _id: req.params.id, organization: req.org }).lean();
    if (!j) throw new HttpError(404, "Journal not found");
    const accounts = await chartOfAccounts(req.org);
    const name = (c) => (accounts.find((a) => a.code === c) || { name: "Deleted account" }).name;
    res.send({ ...j, lines: j.lines.map((l) => ({ ...l, accountName: name(l.account) })) });
  })
);

router.put(
  "/:id",
  ah(async (req, res) => {
    const j = await Journal.findOne({ _id: req.params.id, organization: req.org });
    if (!j) throw new HttpError(404, "Journal not found");
    const data = validate(schema, req.body);
    const { lines, total } = await check(req, data);
    j.set({ ...data, number: data.number || j.number, lines, total });
    await j.save();
    res.send(j);
  })
);

router.delete(
  "/:id",
  ah(async (req, res) => {
    const r = await Journal.deleteOne({ _id: req.params.id, organization: req.org });
    if (!r.deletedCount) throw new HttpError(404, "Journal not found");
    res.send({ message: "Journal deleted" });
  })
);

module.exports = router;
