/**
 * Opening stock as in Tally's books: Tally's Opening Stock ledger can differ from its stock items' opening values
 * (accounts and inventory not integrated). The difference is posted, on the opening date, to "Opening Stock
 * Difference (Tally)" against Opening Balance Equity — so the P&L (Tally view shows it as part of Opening Stock),
 * the Balance Sheet and the Trial Balance match Tally. Same entry the Tally masters import makes.
 */
const { round2 } = require("./http");

async function openingStockInfo(org) {
  const Item = require("../models/Item");
  const Organization = require("../models/Organization");
  const Journal = require("../models/Journal");
  const items = await Item.find(
    { organization: org, trackInventory: true, openingStock: { $gt: 0 } },
    { openingStock: 1, openingStockRate: 1, openingStockDate: 1 },
  ).lean();
  const itemsTotal = round2(
    items.reduce(
      (t, i) => t + round2(i.openingStock * (i.openingStockRate || 0)),
      0,
    ),
  );
  const dates = items
    .map((i) => i.openingStockDate)
    .filter(Boolean)
    .map((d) => new Date(d));
  const fy = require("./inventory").fyOf(new Date());
  const date = dates.length
    ? new Date(Math.min(...dates))
    : new Date(Date.UTC(fy, 3, 1) - 5.5 * 3600000);
  const o = await Organization.findById(org, {
    tallyOpeningStock: 1,
    closingStock: 1,
  }).lean();
  const diffJournals = (
    await Journal.find(
      { organization: org },
      { importRef: 1, total: 1, lines: 1, date: 1 },
    ).lean()
  ).filter((j) => /opening-stock-diff/.test(j.importRef || ""));
  return {
    itemsTotal,
    date,
    target: o?.tallyOpeningStock ?? null,
    diffJournals,
    closingStock: (o?.closingStock || []).sort(
      (a, b) => new Date(a.date) - new Date(b.date),
    ),
  };
}

// Set the opening stock the books should show (null = the items' own values). → { itemsTotal, target, diff }
async function setOpeningStock(org, target) {
  const Organization = require("../models/Organization");
  const Journal = require("../models/Journal");
  const Account = require("../models/Account");
  const { nextNumber } = require("../models/Counter");
  const info = await openingStockInfo(org);
  for (const j of info.diffJournals) await Journal.deleteOne({ _id: j._id });
  await Organization.updateOne(
    { _id: org },
    target == null
      ? { $unset: { tallyOpeningStock: 1 } }
      : { $set: { tallyOpeningStock: round2(target) } },
  );
  const diff = target == null ? 0 : round2(target - info.itemsTotal);
  if (Math.abs(diff) >= 0.01) {
    let acc = await Account.findOne({
      organization: org,
      role: "opening_stock_diff",
    });
    if (!acc)
      acc = await Account.create({
        organization: org,
        name: "Opening Stock Difference (Tally)",
        group: "Cost Of Goods Sold",
        role: "opening_stock_diff",
        description:
          "Tally's Opening Stock ledger minus its stock items' opening values. Shown as part of Opening Stock in the Tally view of reports.",
      });
    const o = await Organization.findById(org, { journalPrefix: 1 }).lean();
    const a = Math.abs(diff);
    await Journal.create({
      organization: org,
      number: await nextNumber(org, "journal", o?.journalPrefix || "MJ-"),
      date: info.date,
      reference: "Opening stock difference",
      notes: `Opening stock as per books ₹${round2(target).toLocaleString("en-IN")} − items' opening values ₹${info.itemsTotal.toLocaleString("en-IN")}`,
      lines: [
        {
          account: String(acc._id),
          description: "Opening stock as per books",
          debit: diff > 0 ? a : 0,
          credit: diff < 0 ? a : 0,
        },
        {
          account: "opening_equity",
          description: "Opening stock difference",
          debit: diff < 0 ? a : 0,
          credit: diff > 0 ? a : 0,
        },
      ],
      total: a,
      importRef: `manual:opening-stock-diff|${info.date.toISOString().slice(0, 10)}`,
    });
  }
  return { itemsTotal: info.itemsTotal, target, diff };
}

module.exports = { openingStockInfo, setOpeningStock };
