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
    // Pass 3: lines added earlier from alert emails become the statement's line (same amount and direction,
    // within 3 days; the alert's reference number found in the statement line decides between two).
    const alerts = await BankStatementLine.find({ organization: org, account: code, source: "alert" }).lean();
    const ref = (s) => String(s || "").replace(/[^0-9A-Z]/gi, "").toUpperCase();
    const confirmed = [];
    for (const c of candidates) {
      if (skip.has(c.i) || !alerts.length) continue;
      const t = new Date(c.r.date).getTime();
      const text = ref(`${c.r.description} ${c.r.reference}`);
      const pool = alerts
        .filter((a) => !a._used && round2(a.deposit) === c.deposit && round2(a.withdrawal) === c.withdrawal && Math.abs(new Date(a.date) - t) <= 3 * 86400000)
        .map((a) => ({ a, refHit: a.reference && ref(a.reference).length >= 6 && text.includes(ref(a.reference)), days: Math.abs(new Date(a.date) - t) }))
        .sort((x, y) => (y.refHit ? 1 : 0) - (x.refHit ? 1 : 0) || x.days - y.days);
      if (!pool.length) continue;
      const hit = pool[0].a;
      hit._used = true;
      skip.add(c.i);
      confirmed.push({ id: hit._id, c, hit });
    }
    for (const { id, c, hit } of confirmed)
      await BankStatementLine.updateOne(
        { _id: id },
        {
          $set: {
            date: c.r.date,
            description: c.r.description || hit.description,
            reference: c.r.reference || hit.reference || "",
            balance: c.balance,
            seq: c.i,
            source: "statement",
            alertText: hit.alertText || hit.description,
            notInStatement: false,
          },
        },
      );
    // Alert lines inside the statement's dates that the statement doesn't have: flag them to check.
    let notInStatement = 0;
    const dates = rows.map((r) => new Date(r.date).getTime()).filter((x) => !isNaN(x));
    if (dates.length && alerts.length) {
      const from = Math.min(...dates);
      const to = Math.max(...dates);
      const odd = alerts.filter((a) => !a._used && new Date(a.date) >= from && new Date(a.date) <= to - 86400000).map((a) => a._id);
      notInStatement = odd.length;
      if (odd.length) await BankStatementLine.updateMany({ _id: { $in: odd } }, { $set: { notInStatement: true } });
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
    const skipped = skip.size - confirmed.length;
    const inserted = docs.length ? await BankStatementLine.insertMany(docs) : [];
    // Transaction rules categorise matching lines straight away.
    const rules = await applyRules(org, inserted);
  return { imported: docs.length, skipped, ignored, rules, confirmed: confirmed.length, notInStatement };
}

/**
 * One line from a transaction alert email (bankFeed.js). Skipped if this email already made a line; rules apply.
 * `a` = { date, description, reference, deposit, withdrawal, balance, alertId }.
 */
async function importAlert(org, code, a) {
  if (await BankStatementLine.exists({ organization: org, account: code, alertId: a.alertId })) return { imported: 0, skipped: 1 };
  const doc = await BankStatementLine.create({
    organization: org,
    account: code,
    date: a.date,
    description: a.description,
    reference: a.reference || "",
    deposit: round2(a.deposit),
    withdrawal: round2(a.withdrawal),
    balance: a.balance === null || a.balance === undefined ? null : round2(a.balance),
    seq: 0,
    batch: "alert",
    source: "alert",
    alertId: a.alertId,
    alertText: a.description,
  });
  const rules = await applyRules(org, [doc]);
  return { imported: 1, skipped: 0, rules };
}

module.exports = { importRows, importAlert };
