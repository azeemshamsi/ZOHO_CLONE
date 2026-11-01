const router = require("express").Router();
const Joi = require("joi");
const BankStatementLine = require("../models/BankStatementLine");
const BankReconciliation = require("../models/BankReconciliation");
const Account = require("../models/Account");
const Expense = require("../models/Expense");
const Journal = require("../models/Journal");
const Organization = require("../models/Organization");
const { nextNumber } = require("../models/Counter");
const { ah, validate, HttpError, round2 } = require("../utils/http");
const { chartOfAccounts, buildEntries, movements, naturalBalance } = require("../utils/ledger");
const { entryKey, usedKeys, candidatesFor, matchLine, context, categorizeLine, undoLine, applyRules } = require("../utils/bankActions");

const DAY = 24 * 60 * 60 * 1000;

async function bankAccounts(org) {
  return (await chartOfAccounts(org)).filter((a) => ["Cash", "Bank"].includes(a.group));
}

async function findBankAccount(req, code) {
  const acc = (await bankAccounts(req.org)).find((a) => a.code === code);
  if (!acc) throw new HttpError(404, "Bank account not found");
  return acc;
}


router.get(
  "/accounts",
  ah(async (req, res) => {
    const [accounts, entries, stats] = await Promise.all([
      bankAccounts(req.org),
      buildEntries(req.org),
      BankStatementLine.find({ organization: req.org }, { account: 1, status: 1, deposit: 1, withdrawal: 1, date: 1, balance: 1, createdAt: 1, seq: 1 }).lean(),
    ]);
    const mv = movements(entries);
    const by = {};
    stats.sort((a, b) => new Date(a.date) - new Date(b.date) || new Date(a.createdAt) - new Date(b.createdAt) || (a.seq || 0) - (b.seq || 0));
    for (const l of stats) {
      const b = (by[l.account] = by[l.account] || { lines: 0, unmatched: 0, net: 0, lastDate: null });
      b.lines += 1;
      if (l.status === "unmatched") b.unmatched += 1;
      b.net += l.deposit - l.withdrawal;
      if (!b.lastDate || l.date > b.lastDate) b.lastDate = l.date;
      if (l.balance !== null && l.balance !== undefined) {
        b.lastBalance = l.balance;
        b.lastBalanceDate = l.date;
      }
    }
    res.send(
      accounts.map((a) => ({
        ...a,
        balance: naturalBalance(a, mv[a.code]),
        statement: by[a.code]
          ? {
              lines: by[a.code].lines,
              unmatched: by[a.code].unmatched,
              net: round2(by[a.code].net),
              lastDate: by[a.code].lastDate,
              lastBalance: by[a.code].lastBalance ?? null,
              lastBalanceDate: by[a.code].lastBalanceDate ?? null,
            }
          : { lines: 0, unmatched: 0, net: 0, lastDate: null, lastBalance: null, lastBalanceDate: null },
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

// All lines of an account in statement order (date, then import, then position in the file).
async function orderedLines(org, code) {
  const lines = await BankStatementLine.find({ organization: org, account: code }).lean();
  return lines.sort((a, b) => new Date(a.date) - new Date(b.date) || new Date(a.createdAt) - new Date(b.createdAt) || (a.seq || 0) - (b.seq || 0));
}

// Check each line's balance against the one before it: balance = previous + deposit − withdrawal.
function checkRunningBalance(lines) {
  let prev = null;
  for (const l of lines) {
    if (l.balance !== null && l.balance !== undefined) {
      if (prev !== null) {
        const expected = round2(prev + l.deposit - l.withdrawal);
        l.expectedBalance = expected;
        l.balanceMismatch = Math.abs(expected - l.balance) > 0.005;
      }
      prev = l.balance;
    }
  }
  return lines;
}

router.get(
  "/:code/lines",
  ah(async (req, res) => {
    await findBankAccount(req, req.params.code);
    let lines = checkRunningBalance(await orderedLines(req.org, req.params.code));
    if (req.query.status && req.query.status !== "all") lines = lines.filter((l) => l.status === req.query.status);
    res.send(lines);
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
              balance: Joi.number().allow(null).default(null),
            })
          )
          .min(1)
          .max(5000)
          .required()
          .label("Statement rows"),
      }),
      req.body
    );
    // Skip only lines that are already in MGI. Statements often contain genuinely identical lines
    // (two ₹59 SMS charges on the same day), so duplicates are counted, not just looked up:
    // if MGI has 1 such line and the file has 2, the second one is imported.
    const keyOf = (date, deposit, withdrawal, description) =>
      `${new Date(date).toISOString().slice(0, 10)}|${deposit}|${withdrawal}|${String(description || "").trim().toLowerCase()}`;
    const existing = await BankStatementLine.find(
      { organization: req.org, account: req.params.code },
      { date: 1, deposit: 1, withdrawal: 1, description: 1, balance: 1 }
    ).lean();
    const have = {}; // key -> balances of lines already in MGI (null when unknown)
    for (const l of existing) (have[keyOf(l.date, l.deposit, l.withdrawal, l.description)] ||= []).push(l.balance ?? null);

    const batch = `b${Date.now()}`;
    const candidates = [];
    let ignored = 0;
    for (const [i, r] of rows.entries()) {
      const deposit = round2(r.deposit);
      const withdrawal = round2(r.withdrawal);
      if (!deposit && !withdrawal) {
        ignored++;
        continue;
      }
      const balance = r.balance === null || r.balance === undefined ? null : round2(r.balance);
      candidates.push({ i, r, deposit, withdrawal, balance, key: keyOf(r.date, deposit, withdrawal, r.description) });
    }
    // Pass 1: a line whose bank balance matches a line already in MGI is that same line.
    const skip = new Set();
    for (const c of candidates) {
      const pool = have[c.key];
      if (!pool || c.balance === null) continue;
      const at = pool.indexOf(c.balance);
      if (at !== -1) {
        pool.splice(at, 1);
        skip.add(c.i);
      }
    }
    // Pass 2: for lines without a matching balance, skip only as many as MGI still has.
    for (const c of candidates) {
      if (skip.has(c.i)) continue;
      const pool = have[c.key];
      if (!pool || !pool.length) continue;
      // An existing line with a known, different balance is a different transaction.
      const at = pool.findIndex((b) => b === null || c.balance === null);
      if (at === -1) continue;
      pool.splice(at, 1);
      skip.add(c.i);
    }
    const docs = [];
    for (const c of candidates) {
      if (skip.has(c.i)) continue;
      docs.push({
        organization: req.org,
        account: req.params.code,
        date: c.r.date,
        description: c.r.description || "",
        reference: c.r.reference || "",
        deposit: c.deposit,
        withdrawal: c.withdrawal,
        balance: c.balance,
        seq: c.i,
        batch,
      });
    }
    const skipped = skip.size;
    const inserted = docs.length ? await BankStatementLine.insertMany(docs) : [];
    // Transaction rules categorise matching lines straight away.
    const rules = await applyRules(req.org, inserted);
    res.status(201).send({ imported: docs.length, skipped, ignored, rules });
  })
);

/**
 * Bank reconciliation as of a date.
 *   Balance as per bank = Balance as per books
 *                         − book entries the bank hasn't processed yet (deposits in transit, uncleared cheques)
 *                         + statement lines not yet recorded in the books
 *                         + excluded statement lines
 * Anything left over is an unexplained difference.
 */
async function reconcile(req, code, asOfStr, override) {
  const acc = await findBankAccount(req, code);
  const asOf = new Date(`${asOfStr}T23:59:59.999Z`);
  if (isNaN(asOf)) throw new HttpError(400, "Invalid date");
  const lines = checkRunningBalance(await orderedLines(req.org, code));
  const upTo = lines.filter((l) => new Date(l.date) <= asOf);
  const withBal = upTo.filter((l) => l.balance !== null && l.balance !== undefined);
  const autoBalance = withBal.length ? withBal[withBal.length - 1].balance : null;
  const statementBalance = override !== undefined && override !== null && override !== "" ? round2(Number(override)) : autoBalance;

  const start = lines.length ? new Date(lines[0].date) : null;
  const first = lines[0];
  const statementOpening =
    first && first.balance !== null && first.balance !== undefined ? round2(first.balance - first.deposit + first.withdrawal) : null;

  const entries = await buildEntries(req.org, { to: asOf });
  const bookBalance = naturalBalance(acc, movements(entries)[code]);
  const bookOpening = start ? naturalBalance(acc, movements(entries, { to: new Date(start.getTime() - 1) })[code]) : null;

  const matchedKeys = new Set(lines.map((l) => l.match && l.match.key).filter(Boolean));
  const uncleared = [];
  for (const e of entries) {
    if (start && new Date(e.date) < start) continue;
    for (const l of e.lines) {
      if (l.account !== code) continue;
      if (matchedKeys.has(entryKey(e, l))) continue;
      uncleared.push({ date: e.date, type: e.type, id: e.id, number: e.number, party: e.party, amount: round2(l.debit - l.credit) });
    }
  }
  const pick = (l) => ({ _id: l._id, date: l.date, description: l.description, reference: l.reference, amount: round2(l.deposit - l.withdrawal) });
  const notInBooks = upTo.filter((l) => l.status === "unmatched").map(pick);
  const excluded = upTo.filter((l) => l.status === "excluded").map(pick);
  const net = (xs) => round2(xs.reduce((s, x) => s + x.amount, 0));
  const unclearedNet = net(uncleared);
  const notInBooksNet = net(notInBooks);
  const excludedNet = net(excluded);
  const adjusted = round2(bookBalance - unclearedNet + notInBooksNet + excludedNet);
  const difference = statementBalance === null ? null : round2(statementBalance - adjusted);
  return {
    account: acc,
    asOf,
    statementBalance,
    autoBalance,
    statementStart: start,
    statementOpening,
    bookOpening,
    openingDifference: statementOpening === null || bookOpening === null ? null : round2(statementOpening - bookOpening),
    bookBalance,
    uncleared,
    unclearedNet,
    notInBooks,
    notInBooksNet,
    excluded,
    excludedNet,
    adjusted,
    difference,
    reconciled: difference === 0,
    balanceBreaks: upTo.filter((l) => l.balanceMismatch).map((l) => ({ _id: l._id, date: l.date, description: l.description, balance: l.balance, expected: l.expectedBalance })),
  };
}

router.get(
  "/:code/reconcile",
  ah(async (req, res) => {
    const asOf = req.query.asOf || new Date().toISOString().slice(0, 10);
    res.send(await reconcile(req, req.params.code, asOf, req.query.statementBalance));
  })
);

router.get(
  "/:code/reconciliations",
  ah(async (req, res) => {
    await findBankAccount(req, req.params.code);
    res.send(await BankReconciliation.find({ organization: req.org, account: req.params.code }).sort({ asOf: -1, createdAt: -1 }));
  })
);

router.post(
  "/:code/reconciliations",
  ah(async (req, res) => {
    const data = validate(
      Joi.object({
        asOf: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required().label("Date"),
        statementBalance: Joi.number().required().label("Balance as per bank"),
        notes: Joi.string().allow(""),
      }),
      req.body
    );
    const r = await reconcile(req, req.params.code, data.asOf, data.statementBalance);
    const rec = await BankReconciliation.create({
      organization: req.org,
      account: req.params.code,
      asOf: new Date(`${data.asOf}T00:00:00.000Z`),
      statementBalance: r.statementBalance,
      bookBalance: r.bookBalance,
      unclearedInBooks: r.unclearedNet,
      notInBooks: round2(r.notInBooksNet + r.excludedNet),
      difference: r.difference,
      notes: data.notes || "",
    });
    res.status(201).send(rec);
  })
);

router.delete(
  "/reconciliations/:id",
  ah(async (req, res) => {
    const r = await BankReconciliation.deleteOne({ _id: req.params.id, organization: req.org });
    if (!r.deletedCount) throw new HttpError(404, "Reconciliation not found");
    res.send({ message: "Reconciliation deleted" });
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
    const [entries, used] = await Promise.all([buildEntries(req.org), usedKeys(req.org, line.account)]);
    res.send(candidatesFor(line, entries, used).slice(0, 10));
  })
);

router.post(
  "/lines/:id/match",
  ah(async (req, res) => {
    const { key } = validate(Joi.object({ key: Joi.string().required() }), req.body);
    const line = await findLine(req);
    if (line.status !== "unmatched") throw new HttpError(400, "This line is already matched or categorised");
    const [entries, used] = await Promise.all([buildEntries(req.org), usedKeys(req.org, line.account)]);
    if (used.has(key)) throw new HttpError(400, "That transaction is already matched to another statement line");
    const found = candidatesFor(line, entries, used).find((c) => c.key === key);
    if (!found) throw new HttpError(400, "That transaction no longer exists");
    matchLine(line, found);
    await line.save();
    res.send(line);
  })
);

// Record a new transaction straight from the statement line.
const categorizeSchema = Joi.object({
  account: Joi.string().required().label("Account"),
  notes: Joi.string().allow(""),
  taxRate: Joi.number().min(0).max(100).default(0),
});

router.post(
  "/lines/:id/categorize",
  ah(async (req, res) => {
    const data = validate(categorizeSchema, req.body);
    const line = await findLine(req);
    res.send(await categorizeLine(req.org, line, data, await context(req.org)));
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
  ah(async (req, res) => res.send(await undoLine(req.org, await findLine(req))))
);

// Run transaction rules on this account's unmatched lines (or just the ones picked).
router.post(
  "/:code/apply-rules",
  ah(async (req, res) => {
    await findBankAccount(req, req.params.code);
    const { ids } = validate(Joi.object({ ids: Joi.array().items(Joi.string()).default([]) }), req.body);
    const filter = { organization: req.org, account: req.params.code, status: "unmatched" };
    if (ids.length) filter._id = { $in: ids };
    const lines = await BankStatementLine.find(filter).sort({ date: 1, seq: 1 });
    res.send(await applyRules(req.org, lines));
  })
);

/**
 * Bulk actions on ticked lines.
 *  categorize: record each against one account   exclude: ignore them
 *  automatch: match each to the closest MGI transaction with the same amount (within 7 days)
 *  undo: undo matches/categorisations/exclusions
 */
router.post(
  "/lines/bulk",
  ah(async (req, res) => {
    const data = validate(
      Joi.object({
        ids: Joi.array().items(Joi.string()).min(1).max(1000).required().label("Lines"),
        action: Joi.string().valid("categorize", "exclude", "automatch", "undo").required(),
        account: Joi.string().allow(""),
        taxRate: Joi.number().min(0).max(100).default(0),
        notes: Joi.string().allow(""),
      }),
      req.body
    );
    const lines = await BankStatementLine.find({ organization: req.org, _id: { $in: data.ids } }).sort({ date: 1, seq: 1 });
    const out = { done: 0, skipped: 0, errors: [] };
    if (data.action === "categorize") {
      if (!data.account) throw new HttpError(400, "Pick an account");
      const ctx = await context(req.org);
      for (const l of lines) {
        if (l.status !== "unmatched") {
          out.skipped++;
          continue;
        }
        try {
          await categorizeLine(req.org, l, { account: data.account, taxRate: l.withdrawal ? data.taxRate : 0, notes: data.notes }, ctx);
          out.done++;
        } catch (e) {
          out.errors.push(e.message);
          out.skipped++;
        }
      }
    } else if (data.action === "exclude") {
      for (const l of lines) {
        if (l.status !== "unmatched") {
          out.skipped++;
          continue;
        }
        l.status = "excluded";
        await l.save();
        out.done++;
      }
    } else if (data.action === "automatch") {
      const entries = await buildEntries(req.org);
      const usedBy = {};
      for (const l of lines) {
        if (l.status !== "unmatched") {
          out.skipped++;
          continue;
        }
        usedBy[l.account] = usedBy[l.account] || (await usedKeys(req.org, l.account));
        const best = candidatesFor(l, entries, usedBy[l.account]).find((c) => c.days <= 7);
        if (!best) {
          out.skipped++;
          continue;
        }
        matchLine(l, best);
        usedBy[l.account].add(best.key);
        await l.save();
        out.done++;
      }
    } else {
      for (const l of lines) {
        if (l.status === "unmatched") {
          out.skipped++;
          continue;
        }
        await undoLine(req.org, l);
        out.done++;
      }
    }
    out.errors = [...new Set(out.errors)];
    res.send(out);
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
