const router = require("express").Router();
const Joi = require("joi");
const BankStatementLine = require("../models/BankStatementLine");
const Account = require("../models/Account");
const Expense = require("../models/Expense");
const Journal = require("../models/Journal");
const Organization = require("../models/Organization");
const { nextNumber } = require("../models/Counter");
const { ah, validate, HttpError, round2 } = require("../utils/http");
const { chartOfAccounts, buildEntries, movements, naturalBalance } = require("../utils/ledger");

const DAY = 24 * 60 * 60 * 1000;

async function bankAccounts(org) {
  return (await chartOfAccounts(org)).filter((a) => ["Cash", "Bank"].includes(a.group));
}

async function findBankAccount(req, code) {
  const acc = (await bankAccounts(req.org)).find((a) => a.code === code);
  if (!acc) throw new HttpError(404, "Bank account not found");
  return acc;
}

// A unique key for one posting to a bank account (a credit note can have several refunds).
const entryKey = (e, l) => `${e.type}|${e.id}|${new Date(e.date).toISOString().slice(0, 10)}|${l.debit}|${l.credit}`;

router.get(
  "/accounts",
  ah(async (req, res) => {
    const [accounts, entries, stats] = await Promise.all([
      bankAccounts(req.org),
      buildEntries(req.org),
      BankStatementLine.find({ organization: req.org }, { account: 1, status: 1, deposit: 1, withdrawal: 1, date: 1 }).lean(),
    ]);
    const mv = movements(entries);
    const by = {};
    for (const l of stats) {
      const b = (by[l.account] = by[l.account] || { lines: 0, unmatched: 0, net: 0, lastDate: null });
      b.lines += 1;
      if (l.status === "unmatched") b.unmatched += 1;
      b.net += l.deposit - l.withdrawal;
      if (!b.lastDate || l.date > b.lastDate) b.lastDate = l.date;
    }
    res.send(
      accounts.map((a) => ({
        ...a,
        balance: naturalBalance(a, mv[a.code]),
        statement: by[a.code]
          ? { lines: by[a.code].lines, unmatched: by[a.code].unmatched, net: round2(by[a.code].net), lastDate: by[a.code].lastDate }
          : { lines: 0, unmatched: 0, net: 0, lastDate: null },
      }))
    );
  })
);

router.post(
  "/accounts",
  ah(async (req, res) => {
    const data = validate(
      Joi.object({
        name: Joi.string().trim().min(1).max(120).required().label("Account name"),
        group: Joi.string().valid("Bank", "Cash").default("Bank"),
        accountCode: Joi.string().allow(""),
        description: Joi.string().allow(""),
      }),
      req.body
    );
    const all = await chartOfAccounts(req.org);
    if (all.some((a) => a.name.toLowerCase() === data.name.toLowerCase())) throw new HttpError(409, "An account with this name already exists");
    res.status(201).send(await Account.create({ ...data, organization: req.org }));
  })
);

router.get(
  "/:code/lines",
  ah(async (req, res) => {
    await findBankAccount(req, req.params.code);
    const filter = { organization: req.org, account: req.params.code };
    if (req.query.status && req.query.status !== "all") filter.status = req.query.status;
    res.send(await BankStatementLine.find(filter).sort({ date: -1, createdAt: -1 }));
  })
);

// Import rows already parsed from the bank's CSV in the browser.
router.post(
  "/:code/import",
  ah(async (req, res) => {
    await findBankAccount(req, req.params.code);
    const { rows } = validate(
      Joi.object({
        rows: Joi.array()
          .items(
            Joi.object({
              date: Joi.date().required(),
              description: Joi.string().allow("").max(500),
              reference: Joi.string().allow("").max(200),
              deposit: Joi.number().min(0).default(0),
              withdrawal: Joi.number().min(0).default(0),
            })
          )
          .min(1)
          .max(5000)
          .required()
          .label("Statement rows"),
      }),
      req.body
    );
    const existing = await BankStatementLine.find({ organization: req.org, account: req.params.code }, { date: 1, deposit: 1, withdrawal: 1, description: 1 }).lean();
    const seen = new Set(existing.map((l) => `${new Date(l.date).toISOString().slice(0, 10)}|${l.deposit}|${l.withdrawal}|${l.description}`));
    const batch = `b${Date.now()}`;
    const docs = [];
    let skipped = 0;
    for (const r of rows) {
      const deposit = round2(r.deposit);
      const withdrawal = round2(r.withdrawal);
      if (!deposit && !withdrawal) {
        skipped++;
        continue;
      }
      const k = `${new Date(r.date).toISOString().slice(0, 10)}|${deposit}|${withdrawal}|${r.description || ""}`;
      if (seen.has(k)) {
        skipped++;
        continue;
      }
      seen.add(k);
      docs.push({ organization: req.org, account: req.params.code, date: r.date, description: r.description || "", reference: r.reference || "", deposit, withdrawal, batch });
    }
    if (docs.length) await BankStatementLine.insertMany(docs);
    res.status(201).send({ imported: docs.length, skipped });
  })
);

async function findLine(req) {
  const line = await BankStatementLine.findOne({ _id: req.params.id, organization: req.org });
  if (!line) throw new HttpError(404, "Statement line not found");
  return line;
}

// MGI transactions on this account with the same amount, closest date first.
router.get(
  "/lines/:id/suggestions",
  ah(async (req, res) => {
    const line = await findLine(req);
    const [entries, taken] = await Promise.all([
      buildEntries(req.org),
      BankStatementLine.find({ organization: req.org, account: line.account, "match.key": { $exists: true } }, { "match.key": 1 }).lean(),
    ]);
    const used = new Set(taken.map((t) => t.match && t.match.key).filter(Boolean));
    const out = [];
    for (const e of entries) {
      for (const l of e.lines) {
        if (l.account !== line.account) continue;
        const fits = line.deposit ? l.debit === line.deposit : l.credit === line.withdrawal;
        if (!fits) continue;
        const key = entryKey(e, l);
        if (used.has(key)) continue;
        const days = Math.round(Math.abs(new Date(e.date) - new Date(line.date)) / DAY);
        out.push({ key, type: e.type, id: e.id, number: e.number, party: e.party, date: e.date, amount: l.debit || l.credit, days });
      }
    }
    out.sort((a, b) => a.days - b.days);
    res.send(out.slice(0, 10));
  })
);

router.post(
  "/lines/:id/match",
  ah(async (req, res) => {
    const { key } = validate(Joi.object({ key: Joi.string().required() }), req.body);
    const line = await findLine(req);
    if (line.status !== "unmatched") throw new HttpError(400, "This line is already matched or categorised");
    const entries = await buildEntries(req.org);
    let found = null;
    for (const e of entries) for (const l of e.lines) if (l.account === line.account && entryKey(e, l) === key) found = e;
    if (!found) throw new HttpError(400, "That transaction no longer exists");
    if (await BankStatementLine.exists({ organization: req.org, "match.key": key })) throw new HttpError(400, "That transaction is already matched to another statement line");
    line.status = "matched";
    line.match = { type: found.type, id: found.id, number: found.number, key };
    await line.save();
    res.send(line);
  })
);

// Record a new transaction straight from the statement line.
router.post(
  "/lines/:id/categorize",
  ah(async (req, res) => {
    const data = validate(
      Joi.object({
        account: Joi.string().required().label("Account"),
        notes: Joi.string().allow(""),
        taxRate: Joi.number().min(0).max(100).default(0),
      }),
      req.body
    );
    const line = await findLine(req);
    if (line.status !== "unmatched") throw new HttpError(400, "This line is already matched or categorised");
    const accounts = await chartOfAccounts(req.org);
    const target = accounts.find((a) => a.code === data.account);
    if (!target) throw new HttpError(400, "Pick an account");
    if (["ar", "ap", line.account].includes(target.code)) {
      throw new HttpError(400, "Use Record Payment / Payments Made for customers and vendors, then match the line");
    }
    const description = data.notes || line.description;
    let match;
    if (line.withdrawal && target.type === "expense") {
      // Spending → an expense (GST included in the amount if a rate is given).
      const org = await Organization.findById(req.org);
      const rate = Number(data.taxRate) || 0;
      const base = round2(line.withdrawal / (1 + rate / 100));
      const tax = round2(line.withdrawal - base);
      const exp = await Expense.create({
        organization: req.org,
        date: line.date,
        category: target.name,
        account: target.code,
        amount: base,
        taxRate: rate,
        placeOfSupply: org.state,
        isInterState: false,
        cgst: round2(tax / 2),
        sgst: round2(tax - round2(tax / 2)),
        igst: 0,
        total: line.withdrawal,
        paidThrough: line.account === "cash" ? "cash" : "bank_transfer",
        bankAccount: line.account,
        reference: line.reference,
        notes: description,
      });
      match = { type: "Expense", id: exp._id, number: line.reference || target.name };
    } else {
      // Anything else → a journal between the bank and the chosen account.
      const org = await Organization.findById(req.org);
      const amt = line.deposit || line.withdrawal;
      const lines = line.deposit
        ? [{ account: line.account, debit: amt, credit: 0, description }, { account: target.code, debit: 0, credit: amt, description }]
        : [{ account: target.code, debit: amt, credit: 0, description }, { account: line.account, debit: 0, credit: amt, description }];
      const j = await Journal.create({
        organization: req.org,
        number: await nextNumber(req.org, "journal", org.journalPrefix || "MJ-"),
        date: line.date,
        reference: line.reference,
        notes: `Bank: ${description}`,
        lines,
        total: amt,
      });
      match = { type: "Journal", id: j._id, number: j.number };
    }
    const dateStr = new Date(line.date).toISOString().slice(0, 10);
    match.key = `${match.type}|${match.id}|${dateStr}|${line.deposit ? line.deposit : 0}|${line.withdrawal ? line.withdrawal : 0}`;
    line.status = "categorized";
    line.match = match;
    await line.save();
    res.send(line);
  })
);

router.post(
  "/lines/:id/exclude",
  ah(async (req, res) => {
    const line = await findLine(req);
    if (line.status !== "unmatched") throw new HttpError(400, "Undo the match first");
    line.status = "excluded";
    await line.save();
    res.send(line);
  })
);

// Undo a match, categorisation or exclusion. A transaction created by categorising is deleted.
router.post(
  "/lines/:id/undo",
  ah(async (req, res) => {
    const line = await findLine(req);
    if (line.status === "categorized" && line.match?.id) {
      if (line.match.type === "Expense") await Expense.deleteOne({ _id: line.match.id, organization: req.org });
      if (line.match.type === "Journal") await Journal.deleteOne({ _id: line.match.id, organization: req.org });
    }
    line.status = "unmatched";
    line.match = undefined;
    await line.save();
    res.send(line);
  })
);

router.delete(
  "/lines/:id",
  ah(async (req, res) => {
    const line = await findLine(req);
    await line.deleteOne();
    res.send({ message: "Statement line deleted" });
  })
);

module.exports = router;
