const router = require("express").Router();
const Joi = require("joi");
const Budget = require("../models/Budget");
const { ah, validate, HttpError, round2 } = require("../utils/http");
const { chartOfAccounts, buildEntries, movements, naturalBalance } = require("../utils/ledger");

const COUNT = { monthly: 12, quarterly: 4, yearly: 1 };
const MONTHS = ["Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar"];

// Start/end dates and labels of each period in the financial year.
function periods(fy, period) {
  const n = COUNT[period];
  const step = 12 / n;
  return Array.from({ length: n }, (_, i) => {
    const from = new Date(Date.UTC(fy, 3 + i * step, 1));
    const to = new Date(Date.UTC(fy, 3 + (i + 1) * step, 0, 23, 59, 59, 999));
    const yy = (m) => String(m < 9 ? fy : fy + 1).slice(2);
    const label = period === "monthly" ? `${MONTHS[i]} ${yy(i)}` : period === "quarterly" ? `Q${i + 1} (${MONTHS[i * 3]}–${MONTHS[i * 3 + 2]})` : `FY ${fy}-${String(fy + 1).slice(2)}`;
    return { from, to, label };
  });
}

const schema = Joi.object({
  name: Joi.string().trim().required().label("Budget name"),
  fiscalYear: Joi.number().integer().min(2000).max(2100).required(),
  period: Joi.string().valid("monthly", "quarterly", "yearly").required(),
  lines: Joi.array()
    .items(Joi.object({ account: Joi.string().required(), amounts: Joi.array().items(Joi.number().allow(null)).required() }))
    .required(),
});

async function prepare(req, data) {
  const accounts = await chartOfAccounts(req.org);
  const n = COUNT[data.period];
  const seen = new Set();
  data.lines = data.lines
    .filter((l) => accounts.some((a) => a.code === l.account))
    .filter((l) => !seen.has(l.account) && seen.add(l.account))
    .map((l) => ({ account: l.account, amounts: Array.from({ length: n }, (_, i) => round2(Number(l.amounts[i]) || 0)) }))
    .filter((l) => l.amounts.some((x) => x));
  if (!data.lines.length) throw new HttpError(400, "Enter a budget amount for at least one account");
  return data;
}

router.get("/", ah(async (req, res) => res.send(await Budget.find({ organization: req.org }).sort({ fiscalYear: -1, name: 1 }))));

router.get(
  "/:id",
  ah(async (req, res) => {
    const b = await Budget.findOne({ _id: req.params.id, organization: req.org }).lean();
    if (!b) throw new HttpError(404, "Budget not found");
    res.send({ ...b, periods: periods(b.fiscalYear, b.period) });
  })
);

// Budget vs actuals for every account in the budget, per period.
router.get(
  "/:id/actuals",
  ah(async (req, res) => {
    const b = await Budget.findOne({ _id: req.params.id, organization: req.org }).lean();
    if (!b) throw new HttpError(404, "Budget not found");
    const ps = periods(b.fiscalYear, b.period);
    const [accounts, entries] = await Promise.all([chartOfAccounts(req.org), buildEntries(req.org, { to: ps[ps.length - 1].to, branch: req.query.branch })]);
    const mvs = ps.map((p) => movements(entries, { from: p.from, to: p.to }));
    const rows = b.lines.map((l) => {
      const a = accounts.find((x) => x.code === l.account) || { code: l.account, name: l.account, type: "expense", group: "" };
      const actual = mvs.map((mv) => naturalBalance(a, mv[a.code]));
      const budget = l.amounts;
      return { code: a.code, name: a.name, group: a.group, type: a.type, budget, actual, totalBudget: round2(budget.reduce((s, x) => s + x, 0)), totalActual: round2(actual.reduce((s, x) => s + x, 0)) };
    });
    const order = ["income", "expense", "asset", "liability", "equity"];
    rows.sort((x, y) => order.indexOf(x.type) - order.indexOf(y.type) || x.name.localeCompare(y.name));
    res.send({ budget: b, periods: ps, rows });
  })
);

router.post(
  "/",
  ah(async (req, res) => {
    const data = await prepare(req, validate(schema, req.body));
    res.status(201).send(await Budget.create({ ...data, organization: req.org }));
  })
);

router.put(
  "/:id",
  ah(async (req, res) => {
    const data = await prepare(req, validate(schema, req.body));
    const b = await Budget.findOneAndUpdate({ _id: req.params.id, organization: req.org }, data, { new: true });
    if (!b) throw new HttpError(404, "Budget not found");
    res.send(b);
  })
);

router.delete(
  "/:id",
  ah(async (req, res) => {
    const r = await Budget.deleteOne({ _id: req.params.id, organization: req.org });
    if (!r.deletedCount) throw new HttpError(404, "Budget not found");
    res.send({ message: "Budget deleted" });
  })
);

module.exports = router;
module.exports.periods = periods;
