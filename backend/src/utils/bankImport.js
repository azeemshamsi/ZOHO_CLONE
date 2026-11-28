/**
 * Add bank statement rows to a bank account: lines already in OrdexaGo are skipped (duplicates counted, so two
 * genuinely identical lines both come in), then the transaction rules categorise the new lines.
 * Used by the manual upload (Banking → Import) and the automatic email import (bankFeed.js).
 */
const BankStatementLine = require("../models/BankStatementLine");
const { round2 } = require("./http");
const { applyRules } = require("./bankActions");

async function importRows(org, code, rows) {
    // Skip only lines that are already in OrdexaGo. Statements often contain genuinely identical lines
    // (two ₹59 SMS charges on the same day), so duplicates are counted, not just looked up:
    // if OrdexaGo has 1 such line and the file has 2, the second one is imported.
    const keyOf = (date, deposit, withdrawal, description) =>
      `${new Date(date).toISOString().slice(0, 10)}|${deposit}|${withdrawal}|${String(description || "").trim().toLowerCase()}`;
    const existing = await BankStatementLine.find(
      { organization: org, account: code },
      { date: 1, deposit: 1, withdrawal: 1, description: 1, balance: 1 }
    ).lean();
    const have = {}; // key -> balances of lines already in OrdexaGo (null when unknown)
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
    // Pass 1: a line whose bank balance matches a line already in OrdexaGo is that same line.
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
    // Pass 2: for lines without a matching balance, skip only as many as OrdexaGo still has.
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
        organization: org,
        account: code,
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
    const rules = await applyRules(org, inserted);
  return { imported: docs.length, skipped, ignored, rules };
}

module.exports = { importRows };
