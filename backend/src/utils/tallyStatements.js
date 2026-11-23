/**
 * Profit & Loss A/c and Balance Sheet in Tally's horizontal layout: Tally's primary groups on two sides,
 * each with its ledgers (shown when expanded / detailed), totals level at the bottom.
 * Same books and the same figures as the other P&L / Balance Sheet reports (Tally view: Opening and
 * Closing Stock, purchases in full).
 *
 * Shape: { kind: "tally", blocks: [{ left: [group…], right: [group…], total }], net?, diff? }
 *   group: { name, amount, ledgers: [{ name, amount, code?, party? }], style?: "carry" | "result" }
 */
const { round2 } = require("./http");
const { chartOfAccounts, buildEntries, movements, naturalBalance, fiscalYear, parseRange } = require("./ledger");
const TV = require("./tallyView");

const sumOf = (xs) => round2(xs.reduce((t, x) => t + (x.amount || 0), 0));
const group = (name, ledgers, extra = {}) => ({ name, amount: sumOf(ledgers), ledgers: ledgers.filter((l) => l.amount), ...extra });
const ledgersOf = (accounts, mv, test) =>
  accounts
    .filter(test)
    .map((a) => ({ code: a.code, name: a.name, amount: naturalBalance(a, mv[a.code]) }))
    .filter((l) => l.amount)
    .sort((a, b) => a.name.localeCompare(b.name));

// Ledgers Tally keeps under Duties & Taxes (GST, TDS, TCS…), whichever side their balance falls.
const TAX_RX = /\b(gst|cgst|sgst|igst|utgst|cess|tds|tcs|duties|duty|tax)\b/i;
const isTax = (a) => /^(input|output)_/.test(a.code) || (["Other Current Liability", "Other Current Asset"].includes(a.group) && TAX_RX.test(a.name));

// Ledgers that are Direct Expenses in Tally even though bills post to them (Tally lets any ledger be a purchase voucher's).
const DIRECT_RX = /\b(commission|shipping|freight|cartage|carriage|labou?r|wages|courier|transport|packing|loading|octroi|power|fuel)\b/i;

async function profitAndLoss(org, q) {
  const { from, to } = parseRange(q);
  const [accounts, entries] = await Promise.all([chartOfAccounts(org), buildEntries(org, { to })]);
  const tAcc = TV.tallyAccounts(accounts);
  const mv = movements(TV.tallyEntries(entries, accounts), { from, to });
  const opening = round2(TV.stockValue(entries, new Date(from.getTime() - 1)) + naturalBalance(TV.OPENING_STOCK, mv[TV.OPENING_STOCK.code]));
  const closing = TV.stockValue(entries, to);
  const isSales = (a) => a.group === "Income" && (a.ledgerKind === "sales" || a.code === "sales");
  // Tally's own group decides when the ledger came from Tally's masters (or a name says it's a direct expense);
  // otherwise a purchase ledger (bills post to it) is a Purchase Account.
  const isPurchase = (a) =>
    a.group === "Cost Of Goods Sold" &&
    (a.tallyGroup
      ? a.tallyGroup === "Purchase Accounts"
      : a.code === "cogs" || (a.ledgerKind === "purchase" && !DIRECT_RX.test(a.name || "")));

  const openingStock = group("Opening Stock", [{ name: "Opening Stock", amount: opening }]);
  const purchases = group("Purchase Accounts", ledgersOf(tAcc, mv, isPurchase));
  const directExp = group("Direct Expenses", ledgersOf(tAcc, mv, (a) => a.group === "Cost Of Goods Sold" && !isPurchase(a)));
  const sales = group("Sales Accounts", ledgersOf(tAcc, mv, isSales));
  const directInc = group("Direct Incomes", ledgersOf(tAcc, mv, (a) => a.group === "Income" && !isSales(a)));
  const closingStock = group("Closing Stock", [{ name: "Closing Stock", amount: closing }]);
  const indirectExp = group("Indirect Expenses", ledgersOf(tAcc, mv, (a) => a.group === "Expense" || a.group === "Other Expense"));
  const indirectInc = group("Indirect Incomes", ledgersOf(tAcc, mv, (a) => a.group === "Other Income"));

  const dr = round2(openingStock.amount + purchases.amount + directExp.amount);
  const cr = round2(sales.amount + directInc.amount + closingStock.amount);
  const gross = round2(cr - dr);
  const trading = {
    left: [openingStock, purchases, directExp, ...(gross > 0 ? [{ name: "Gross Profit c/o", amount: gross, ledgers: [], style: "carry" }] : [])].filter((g) => g.amount || g.style),
    right: [sales, directInc, closingStock, ...(gross < 0 ? [{ name: "Gross Loss c/o", amount: -gross, ledgers: [], style: "carry" }] : [])].filter((g) => g.amount || g.style),
    total: Math.max(dr, cr),
  };
  const net = round2(gross + indirectInc.amount - indirectExp.amount);
  const left2 = [...(gross < 0 ? [{ name: "Gross Loss b/f", amount: -gross, ledgers: [], style: "carry" }] : []), indirectExp];
  const right2 = [...(gross > 0 ? [{ name: "Gross Profit b/f", amount: gross, ledgers: [], style: "carry" }] : []), indirectInc];
  if (net >= 0) left2.push({ name: "Nett Profit", amount: net, ledgers: [], style: "result" });
  else right2.push({ name: "Nett Loss", amount: -net, ledgers: [], style: "result" });
  const pl = {
    left: left2.filter((g) => g.amount || g.style),
    right: right2.filter((g) => g.amount || g.style),
    total: round2(Math.max(gross, 0) + indirectInc.amount + Math.max(-net, 0)),
  };
  return { kind: "tally", from, to, headings: ["Particulars", "Particulars"], blocks: [trading, pl], net };
}

async function balanceSheet(org, q) {
  const to = q.to ? new Date(`${q.to}T23:59:59.999Z`) : new Date(require("./time").istToday().getTime() + 86400000 - 1);
  const [accounts, entries] = await Promise.all([chartOfAccounts(org), buildEntries(org, { to })]);
  const mv = movements(entries, { to });
  const fy = fiscalYear(to);
  const profit = (f, t) => {
    const m = movements(entries, { from: f, to: t });
    let n = 0;
    for (const a of accounts) if (a.type === "income" || a.type === "expense") n += (a.type === "income" ? 1 : -1) * naturalBalance(a, m[a.code]);
    return round2(n);
  };
  const retained = profit(null, new Date(fy.from.getTime() - 1));
  const current = profit(fy.from, to);

  // Sundry Debtors / Creditors party-wise, as Tally lists them.
  const Customer = require("../models/Customer");
  const Vendor = require("../models/Vendor");
  const [cs, vs] = await Promise.all([Customer.find({ organization: org }, { displayName: 1 }).lean(), Vendor.find({ organization: org }, { displayName: 1 }).lean()]);
  const names = new Map([...cs, ...vs].map((x) => [String(x._id), x.displayName]));
  const parties = (code, sign) => {
    const m = new Map();
    for (const e of entries)
      for (const l of e.lines) {
        if (l.account !== code) continue;
        const k = l.partyId ? String(l.partyId) : "";
        m.set(k, round2((m.get(k) || 0) + sign * ((l.debit || 0) - (l.credit || 0))));
      }
    return [...m.entries()]
      .filter(([, v]) => v)
      .map(([k, v]) => ({ name: k ? names.get(k) || "(deleted party)" : "Other entries", amount: v, party: k ? `${code === "ar" ? "customer" : "vendor"}:${k}` : "" }))
      .sort((a, b) => a.name.localeCompare(b.name));
  };

  const liab = (a) => naturalBalance(a, mv[a.code]); // credit-normal for liabilities / equity
  const asLiability = (a) => {
    const v = naturalBalance(a, mv[a.code]);
    return a.type === "asset" ? -v : v; // an asset ledger in a liability group counts against it
  };
  const capital = group(
    "Capital Account",
    accounts.filter((a) => a.group === "Equity").map((a) => ({ code: a.code, name: a.name, amount: liab(a) })).filter((l) => l.amount)
  );
  const loans = group("Loans (Liability)", ledgersOf(accounts, mv, (a) => a.group === "Long Term Liability"));
  const creditors = group("Sundry Creditors", parties("ap", -1));
  const duties = group(
    "Duties & Taxes",
    accounts.filter(isTax).map((a) => ({ code: a.code, name: a.name, amount: asLiability(a) })).filter((l) => l.amount).sort((a, b) => a.name.localeCompare(b.name))
  );
  const otherCL = ledgersOf(accounts, mv, (a) => a.group === "Other Current Liability" && !isTax(a));
  const currentLiab = { name: "Current Liabilities", amount: round2(creditors.amount + duties.amount + sumOf(otherCL)), ledgers: [...otherCL], subgroups: [duties, creditors].filter((g) => g.amount) };
  const pl = { name: "Profit & Loss A/c", amount: round2(retained + current), ledgers: [{ name: "Opening Balance", amount: retained }, { name: "Current Period", amount: current }].filter((l) => l.amount) };

  const fixed = group("Fixed Assets", ledgersOf(accounts, mv, (a) => a.group === "Fixed Asset"));
  const stock = accounts.find((a) => a.code === "inventory");
  const closingStock = { name: "Closing Stock", amount: stock ? naturalBalance(stock, mv.inventory) : 0, ledgers: [] };
  const debtors = group("Sundry Debtors", parties("ar", 1));
  const cash = group("Cash-in-Hand", ledgersOf(accounts, mv, (a) => a.group === "Cash"));
  const bank = group("Bank Accounts", ledgersOf(accounts, mv, (a) => a.group === "Bank"));
  const otherCA = ledgersOf(accounts, mv, (a) => a.group === "Other Current Asset" && a.code !== "inventory" && !isTax(a));
  const loansAdv = group("Loans & Advances (Asset)", otherCA);
  const subs = [closingStock, debtors, cash, bank, loansAdv].filter((g) => g.amount);
  const currentAssets = { name: "Current Assets", amount: sumOf(subs), ledgers: [], subgroups: subs };

  const left = [capital, loans, currentLiab, pl].filter((g) => g.amount);
  const right = [fixed, currentAssets].filter((g) => g.amount);
  const lt = sumOf(left);
  const rt = sumOf(right);
  // Difference (shouldn't happen: the books balance) shown as Tally does, on the short side.
  const diff = round2(rt - lt);
  if (diff > 0) left.push({ name: "Difference in Opening Balances", amount: diff, ledgers: [], style: "carry" });
  if (diff < 0) right.push({ name: "Difference in Opening Balances", amount: -diff, ledgers: [], style: "carry" });
  return { kind: "tally", to, headings: ["Liabilities", "Assets"], blocks: [{ left, right, total: Math.max(lt, rt) }], diff };
}

module.exports = { profitAndLoss, balanceSheet, isTax };
