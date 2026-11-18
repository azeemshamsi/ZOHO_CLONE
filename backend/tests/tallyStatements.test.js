// Tally horizontal P&L and Balance Sheet: Tally groups, Opening / Closing Stock, Duties & Taxes net, balanced.
const test = require("node:test");
const assert = require("node:assert");
const ledger = require("../src/utils/ledger");
const A = (code, name, group, type, extra = {}) => ({ code, name, group, type, ...extra });
ledger.chartOfAccounts = async () => [
  A("cash", "Cash in Hand", "Cash", "asset"), A("bank", "HDFC Bank", "Bank", "asset"), A("ar", "Accounts Receivable", "Accounts Receivable", "asset"),
  A("inventory", "Inventory Asset", "Other Current Asset", "asset"), A("input_igst", "Input IGST", "Other Current Asset", "asset"),
  A("ap", "Accounts Payable", "Accounts Payable", "liability"), A("output_igst", "Output IGST", "Other Current Liability", "liability"),
  A("owners_equity", "Capital", "Equity", "equity"), A("sales", "Sales", "Income", "income"), A("cogs", "Cost of Goods Sold", "Cost Of Goods Sold", "expense"),
  A("rent", "Rent", "Expense", "expense"),
];
const d = (s) => new Date(`${s}T06:00:00Z`);
ledger.buildEntries = async () => [
  { date: d("2026-04-01"), type: "Journal", lines: [{ account: "cash", debit: 10000, credit: 0 }, { account: "owners_equity", debit: 0, credit: 10000 }] },
  { date: d("2026-04-02"), type: "Bill", lines: [{ account: "cogs", debit: 5000, credit: 0 }, { account: "input_igst", debit: 900, credit: 0 }, { account: "ap", debit: 0, credit: 5900, partyId: "v1" }, { account: "inventory", debit: 5000, credit: 0, stock: true }, { account: "cogs", debit: 0, credit: 5000, stock: true }] },
  { date: d("2026-04-05"), type: "Invoice", lines: [{ account: "ar", debit: 2360, credit: 0, partyId: "c1" }, { account: "sales", debit: 0, credit: 2000 }, { account: "output_igst", debit: 0, credit: 360 }, { account: "cogs", debit: 3000, credit: 0, stock: true }, { account: "inventory", debit: 0, credit: 3000, stock: true }] },
  { date: d("2026-04-06"), type: "Expense", lines: [{ account: "rent", debit: 500, credit: 0 }, { account: "cash", debit: 0, credit: 500 }] },
  { date: d("2026-04-07"), type: "Customer Payment", lines: [{ account: "bank", debit: 2000, credit: 0 }, { account: "ar", debit: 0, credit: 2000, partyId: "c1" }] },
];
const Customer = require("../src/models/Customer");
const Vendor = require("../src/models/Vendor");
Customer.find = () => ({ lean: async () => [{ _id: "c1", displayName: "Asha" }] });
Vendor.find = () => ({ lean: async () => [{ _id: "v1", displayName: "Woodcraft" }] });
const TS = require("../src/utils/tallyStatements");
const g = (side, name) => side.find((x) => x.name === name);

test("P&L: trading account with stock, then indirect expenses, nett loss", async () => {
  const r = await TS.profitAndLoss("o", { from: "2026-04-01", to: "2026-04-30" });
  const [tr, pl] = r.blocks;
  assert.strictEqual(g(tr.left, "Purchase Accounts").amount, 5000);
  assert.strictEqual(g(tr.right, "Sales Accounts").amount, 2000);
  assert.strictEqual(g(tr.right, "Closing Stock").amount, 2000);
  assert.strictEqual(g(tr.right, "Gross Loss c/o").amount, 1000);
  assert.strictEqual(tr.total, 5000);
  assert.strictEqual(g(pl.left, "Gross Loss b/f").amount, 1000);
  assert.strictEqual(g(pl.left, "Indirect Expenses").amount, 500);
  assert.strictEqual(g(pl.right, "Nett Loss").amount, 1500);
  assert.strictEqual(r.net, -1500);
});

test("Balance sheet: Tally groups, party-wise debtors / creditors, Duties & Taxes net, balanced", async () => {
  const r = await TS.balanceSheet("o", { to: "2026-04-30" });
  const { left, right, total } = r.blocks[0];
  assert.strictEqual(r.diff, 0);
  assert.strictEqual(total, 13860);
  assert.strictEqual(g(left, "Capital Account").amount, 10000);
  const cl = g(left, "Current Liabilities");
  assert.strictEqual(cl.amount, 5360);
  assert.deepStrictEqual(cl.subgroups.map((s) => [s.name, s.amount]), [["Duties & Taxes", -540], ["Sundry Creditors", 5900]]);
  assert.strictEqual(g(left, "Profit & Loss A/c").amount, -1500);
  const ca = g(right, "Current Assets");
  assert.deepStrictEqual(ca.subgroups.map((s) => [s.name, s.amount]), [["Closing Stock", 2000], ["Sundry Debtors", 360], ["Cash-in-Hand", 9500], ["Bank Accounts", 2000]]);
  assert.strictEqual(ca.subgroups[1].ledgers[0].name, "Asha");
});
