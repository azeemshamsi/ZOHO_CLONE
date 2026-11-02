/**
 * Journal lines on Accounts Receivable / Payable that name a customer or vendor (as in Zoho Books:
 * a journal can move an amount between parties, or between a party and any other account).
 * For a customer, a debit is more owed to you and a credit is a credit they can use; for a vendor,
 * a credit is more you owe and a debit is an advance with them.
 */
const Journal = require("../models/Journal");
const { round2 } = require("./http");

const ACCOUNT = { customer: "ar", vendor: "ap" };

// Signed amount of one journal for a party: positive = adds to their balance due.
const signed = (kind, l) => (kind === "customer" ? l.debit - l.credit : l.credit - l.debit);

// party id → net journal amount (positive = due, negative = credit).
async function journalNet(org, kind) {
  const journals = await Journal.find({ organization: org, [`lines.${kind}`]: { $ne: null } }, { lines: 1 }).lean();
  const map = {};
  for (const j of journals)
    for (const l of j.lines)
      if (l[kind] && l.account === ACCOUNT[kind]) {
        const k = String(l[kind]);
        map[k] = round2((map[k] || 0) + signed(kind, l));
      }
  return map;
}

// The journals of one party, newest first, with the amount they add to the party's balance.
async function journalsOf(org, kind, id) {
  const journals = await Journal.find({ organization: org, [`lines.${kind}`]: id }, { number: 1, date: 1, reference: 1, notes: 1, lines: 1 }).sort({ date: -1 }).lean();
  return journals.map((j) => ({
    _id: j._id,
    number: j.number,
    date: j.date,
    reference: j.reference,
    notes: j.notes,
    amount: round2(j.lines.filter((l) => String(l[kind]) === String(id) && l.account === ACCOUNT[kind]).reduce((s, l) => s + signed(kind, l), 0)),
  }));
}

// Split a net amount into what's due and what's a credit.
const split = (net = 0) => ({ due: net > 0 ? net : 0, credit: net < 0 ? round2(-net) : 0 });

module.exports = { journalNet, journalsOf, split };
