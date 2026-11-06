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
  ledgerKind: Joi.string().valid("", "sales", "purchase"),
});

router.get("/types", (req, res) => res.send(Object.keys(ACCOUNT_TYPES)));

/* ---------- master ledgers (groups of sales / purchase ledgers) ---------- */
const LedgerGroup = require("../models/LedgerGroup");
const groupJoi = Joi.object({ kind: Joi.string().valid("sales", "purchase").required(), name: Joi.string().trim().max(100).required().label("Name"), members: Joi.array().items(Joi.string()).default([]) });
// A ledger sits in one master at a time: adding it here takes it out of the others.
async function saveGroup(req, g, d) {
  Object.assign(g, d);
  await g.save();
  if (d.members.length) await LedgerGroup.updateMany({ organization: req.org, kind: d.kind, _id: { $ne: g._id } }, { $pull: { members: { $in: d.members } } });
  return g;
}
router.get(
  "/ledger-groups",
  ah(async (req, res) => {
    const rows = await LedgerGroup.find({ organization: req.org, ...(req.query.kind ? { kind: req.query.kind } : {}) }).lean();
    res.send(rows.sort((a, b) => a.name.localeCompare(b.name)));
  })
);
router.post(
  "/ledger-groups",
  ah(async (req, res) => {
    const d = validate(groupJoi, req.body);
    res.send(await saveGroup(req, new LedgerGroup({ organization: req.org }), d));
  })
);
router.put(
  "/ledger-groups/:id",
  ah(async (req, res) => {
    const d = validate(groupJoi, req.body);
    const g = await LedgerGroup.findOne({ _id: req.params.id, organization: req.org });
    if (!g) throw new HttpError(404, "Master ledger not found");
    res.send(await saveGroup(req, g, d));
  })
);
router.delete(
  "/ledger-groups/:id",
  ah(async (req, res) => {
    await LedgerGroup.deleteOne({ _id: req.params.id, organization: req.org });
    res.send({ ok: true });
  })
);

// Mark sales / purchase ledgers from what invoices, credit notes and bills post to (e.g. after a Tally import).
router.post(
  "/ledger-kinds/refresh",
  ah(async (req, res) => {
    res.send(await require("../utils/import/ledgerKinds").markLedgerKinds(req.org));
  })
);

// All accounts with their balance across every recorded transaction (or as of ?to=YYYY-MM-DD).
router.get(
  "/",
  ah(async (req, res) => {
    const to = req.query.to ? new Date(`${req.query.to}T23:59:59.999Z`) : undefined;
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
// Transactions of several ledgers at once (Tally's transaction view of a group / ledger list), for a period.
router.get(
  "/transactions",
  ah(async (req, res) => {
    const codes = new Set(String(req.query.codes || "").split(",").filter(Boolean));
    if (!codes.size) return res.send({ rows: [], ledgers: [] });
    const accounts = (await chartOfAccounts(req.org)).filter((a) => codes.has(a.code));
    const byCode = new Map(accounts.map((a) => [a.code, a]));
    const { from, to } = parseRange(req.query);
    const entries = await buildEntries(req.org, { to });
    const tot = new Map(accounts.map((a) => [a.code, { code: a.code, name: a.name, opening: 0, debit: 0, credit: 0 }]));
    const rows = [];
    for (const e of entries) {
      for (const l of e.lines) {
        const a = byCode.get(l.account);
        if (!a) continue;
        const sign = debitNormal(a.type) ? 1 : -1;
        const t = tot.get(a.code);
        if (from && new Date(e.date) < from) {
          t.opening = round2(t.opening + sign * (l.debit - l.credit));
          continue;
        }
        t.debit = round2(t.debit + l.debit);
        t.credit = round2(t.credit + l.credit);
        rows.push({ date: e.date, type: e.type, id: e.id, number: e.number, party: e.party, ledger: a.name, code: a.code, debit: l.debit, credit: l.credit });
      }
    }
    rows.sort((x, y) => new Date(x.date) - new Date(y.date));
    const ledgers = [...tot.values()].map((t) => {
      const a = byCode.get(t.code);
      const sign = debitNormal(a.type) ? 1 : -1;
      return { ...t, closing: round2(t.opening + sign * (t.debit - t.credit)) };
    });
    res.send({ from, to, rows: rows.slice(0, 20000), more: rows.length > 20000, ledgers });
  })
);

router.get(
  "/:code/transactions",
  ah(async (req, res) => {
    const accounts = await chartOfAccounts(req.org);
    const acc = accounts.find((a) => a.code === req.params.code);
    if (!acc) throw new HttpError(404, "Account not found");
    const { from, to } = parseRange(req.query);
    // Tally view (default): purchases stay on their purchase ledger, without the moves into stock and the cost of
    // sales, as Tally and the reports show them. "live" shows those stock movements too. Inventory Asset is live only.
    const tally = req.query.view !== "live" && acc.code !== "inventory";
    let entries = await buildEntries(req.org, { to });
    if (tally) entries = require("../utils/tallyView").tallyEntries(entries, accounts);
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
    res.send({ account: acc, from, to, opening, closing: run, rows, view: tally ? "tally" : "live" });
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
