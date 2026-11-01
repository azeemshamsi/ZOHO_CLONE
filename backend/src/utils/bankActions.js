// Shared actions on bank statement lines: match, categorise, undo, and transaction rules.
const Expense = require("../models/Expense");
const Journal = require("../models/Journal");
const Organization = require("../models/Organization");
const BankStatementLine = require("../models/BankStatementLine");
const BankRule = require("../models/BankRule");
const { nextNumber } = require("../models/Counter");
const { HttpError, round2 } = require("./http");
const { chartOfAccounts, buildEntries } = require("./ledger");

const DAY = 24 * 60 * 60 * 1000;

// A unique key for one posting to a bank account (a credit note can have several refunds).
const entryKey = (e, l) => `${e.type}|${e.id}|${new Date(e.date).toISOString().slice(0, 10)}|${l.debit}|${l.credit}`;

// Keys of MGI transactions already matched to some statement line on this account.
async function usedKeys(org, account) {
  const taken = await BankStatementLine.find({ organization: org, account, "match.key": { $exists: true } }, { "match.key": 1 }).lean();
  return new Set(taken.map((t) => t.match && t.match.key).filter(Boolean));
}

// MGI transactions that could be this line: same account, same amount; closest date first.
function candidatesFor(line, entries, used) {
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
  return out.sort((a, b) => a.days - b.days);
}

function matchLine(line, candidate) {
  line.status = "matched";
  line.match = { type: candidate.type, id: candidate.id, number: candidate.number, key: candidate.key };
}

// Context loaded once per request: chart of accounts and the organization.
async function context(org) {
  const [accounts, orgDoc] = await Promise.all([chartOfAccounts(org), Organization.findById(org)]);
  return { accounts, orgDoc };
}

// Record a new transaction from the line: an Expense for spending against an expense account,
// otherwise a Journal between the bank account and the chosen account.
async function categorizeLine(org, line, { account, taxRate = 0, notes = "", rule = "" }, ctx) {
  if (line.status !== "unmatched") throw new HttpError(400, "This line is already matched or categorised");
  const target = ctx.accounts.find((a) => a.code === account);
  if (!target) throw new HttpError(400, "Pick an account");
  if (["ar", "ap", line.account].includes(target.code)) {
    throw new HttpError(400, "Use Record Payment / Payments Made for customers and vendors, then match the line");
  }
  const description = notes || line.description;
  let match;
  if (line.withdrawal && target.type === "expense") {
    const rate = Number(taxRate) || 0;
    const base = round2(line.withdrawal / (1 + rate / 100));
    const tax = round2(line.withdrawal - base);
    const exp = await Expense.create({
      organization: org,
      date: line.date,
      category: target.name,
      account: target.code,
      amount: base,
      taxRate: rate,
      placeOfSupply: ctx.orgDoc.state,
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
    const amt = line.deposit || line.withdrawal;
    const lines = line.deposit
      ? [{ account: line.account, debit: amt, credit: 0, description }, { account: target.code, debit: 0, credit: amt, description }]
      : [{ account: target.code, debit: amt, credit: 0, description }, { account: line.account, debit: 0, credit: amt, description }];
    const j = await Journal.create({
      organization: org,
      number: await nextNumber(org, "journal", ctx.orgDoc.journalPrefix || "MJ-"),
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
  if (rule) match.rule = rule;
  line.status = "categorized";
  line.match = match;
  await line.save();
  return line;
}

// Undo a match, categorisation or exclusion. A transaction created by categorising is deleted.
async function undoLine(org, line) {
  if (line.status === "categorized" && line.match?.id) {
    if (line.match.type === "Expense") await Expense.deleteOne({ _id: line.match.id, organization: org });
    if (line.match.type === "Journal") await Journal.deleteOne({ _id: line.match.id, organization: org });
  }
  line.status = "unmatched";
  line.match = undefined;
  await line.save();
  return line;
}

/* ---------------- Transaction rules ---------------- */
function conditionHolds(c, line) {
  const amount = line.deposit || line.withdrawal;
  if (c.field === "amount") {
    const v = Number(String(c.value).replace(/[^0-9.]/g, ""));
    if (isNaN(v)) return false;
    if (c.op === "equals") return round2(amount) === round2(v);
    if (c.op === "greater_than") return amount > v;
    if (c.op === "less_than") return amount < v;
    return false;
  }
  const text = String(line[c.field] || "").toLowerCase();
  const v = String(c.value || "").toLowerCase().trim();
  if (!v) return false;
  switch (c.op) {
    case "contains":
      return text.includes(v);
    case "not_contains":
      return !text.includes(v);
    case "equals":
      return text.trim() === v;
    case "starts_with":
      return text.trim().startsWith(v);
    case "ends_with":
      return text.trim().endsWith(v);
    default:
      return false;
  }
}

function ruleMatches(rule, line) {
  if (!rule.active || !rule.conditions.length) return false;
  if (rule.applyTo === "withdrawals" && !line.withdrawal) return false;
  if (rule.applyTo === "deposits" && !line.deposit) return false;
  if (rule.accounts.length && !rule.accounts.includes(line.account)) return false;
  return rule.match === "all" ? rule.conditions.every((c) => conditionHolds(c, line)) : rule.conditions.some((c) => conditionHolds(c, line));
}

/**
 * Run the transaction rules over unmatched lines (in rule priority order).
 * A line that already has an MGI transaction with the same amount on the same day is left alone,
 * so a payment you already recorded isn't counted twice — match it instead.
 */
async function applyRules(org, lines) {
  const rules = await BankRule.find({ organization: org, active: true }).sort({ priority: 1, createdAt: 1 }).lean();
  const result = { categorized: 0, skippedHasMatch: 0, byRule: {} };
  const todo = lines.filter((l) => l.status === "unmatched");
  if (!rules.length || !todo.length) return result;
  const ctx = await context(org);
  const entries = await buildEntries(org);
  const usedByAccount = {};
  for (const line of todo) {
    const rule = rules.find((r) => ruleMatches(r, line));
    if (!rule) continue;
    usedByAccount[line.account] = usedByAccount[line.account] || (await usedKeys(org, line.account));
    const sameDay = candidatesFor(line, entries, usedByAccount[line.account]).filter((c) => c.days === 0);
    if (sameDay.length) {
      result.skippedHasMatch++;
      continue;
    }
    await categorizeLine(org, line, { account: rule.account, taxRate: rule.taxRate, notes: rule.notes, rule: rule.name }, ctx);
    result.categorized++;
    result.byRule[rule.name] = (result.byRule[rule.name] || 0) + 1;
  }
  return result;
}

module.exports = { entryKey, usedKeys, candidatesFor, matchLine, context, categorizeLine, undoLine, ruleMatches, applyRules };
